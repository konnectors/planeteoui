process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://1781c74cfbeb4e4298c2e4d63e877304@sentry.cozycloud.cc/117'

const {
  BaseKonnector,
  requestFactory,
  signin,
  scrape,
  saveBills,
  log,
  mkdirp
} = require('cozy-konnector-libs')
const formatDate = require('date-fns/format')
const request = requestFactory({
  // the debug mode shows all the details about http request and responses. Very useful for
  // debugging but very verbose. That is why it is commented out by default
  // debug: true,
  // activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: true,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: false,
  // this allows request-promise to keep cookies between requests
  jar: true
})

const baseUrl = 'https://www.planete-oui.fr'

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  // List all accounts
  const $ = await request(`${baseUrl}/Espace-Client/Accueil`)
  const accounts = $('.listesPdls a')
    .map(function(i, a) {
      const $a = $(a)
      return {
        id: $a.attr('href').match(/site=([0-9a-f]+)&/)[1],
        href: $a.attr('href'),
        name: $a.text().trim()
      }
    })
    .get()

  for (let account of accounts) {
    log('info', `Parsing list of documents for "${account.name}"`)
    // Switch to account
    await request(`${baseUrl}/Espace-Client/Accueil${account.href}`)
    const $ = await request(`${baseUrl}/Espace-Client/Mes-Factures`)
    const documents = parseDocuments($, account)

    log('info', 'Saving data to Cozy')
    // Create sub dir if needed
    const accountFolderPath = [fields.folderPath, account.name].join('/')
    await mkdirp(accountFolderPath)

    await saveBills(
      documents,
      { folderPath: accountFolderPath },
      {
        // this is a bank identifier which will be used to link bills to bank operations. These
        // identifiers should be at least a word found in the title of a bank operation related to this
        // bill. It is not case sensitive.
        // Bank operation example: "Oui Energy Sas 2019-02"
        identifiers: ['Oui Energy']
      }
    )
  }
}

// this shows authentication using the [signin function](https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin)
// even if this in another domain here, but it works as an example
function authenticate(email, password) {
  return signin({
    url: `${baseUrl}/Espace-Client/Connexion`,
    formSelector: '#connexion form',
    formData: { email, password },
    // the validate function will check if the login request was a success. Every website has
    // different ways respond: http status code, error message in html ($), http redirection
    // (fullResponse.request.uri.href)...
    validate: (statusCode, $, fullResponse) => {
      log('debug', fullResponse.request.uri.href)
      // The logout link is only available once signed in.
      if ($(`a[href='/Espace-Client/Deconnexion']`).length >= 1) {
        return true
      } else {
        // cozy-konnector-libs has its own logging function which format these logs with colors in
        // standalone and dev mode and as JSON in production mode
        const errorMessage = $('.error').text()
        if (errorMessage) {
          log('error', errorMessage.trim())
        }
        return false
      }
    }
  })
}

// The goal of this function is to parse a html page wrapped by a cheerio instance
// and return an array of js objects which will be saved to the cozy by saveBills (https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#savebills)
function parseDocuments($, account) {
  // you can find documentation about the scrape function here :
  // https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#scrape
  const docs = scrape(
    $,
    {
      date: {
        sel: 'td:nth-child(1)',
        parse: date => normalizeDate(date)
      },
      href: {
        sel: 'a',
        attr: 'href'
      },
      amount: {
        sel: 'td:nth-child(3)',
        parse: normalizePrice
      }
    },
    '.tableFacturation tbody tr'
  )
  return docs
    .filter(doc => doc.href)
    .map(doc => ({
      ...doc,
      currency: '€',
      fileurl: `${baseUrl}/Espace-Client/${doc.href}`,
      vendor: 'Oui Energy',
      vendorRef: doc.href.split('/').pop(),
      filename: `${formatDate(
        doc.date,
        'YYYY-MM'
      )}_planete-oui_${doc.amount.toFixed(2)}€.pdf`,
      metadata: {
        accountRef: account.id,
        accountName: account.name,
        // it can be interesting that we add the date of import. This is not mandatory but may be
        // useful for debugging or data migration
        importDate: new Date(),
        // document version, useful for migration after change of document structure
        version: 1
      }
    }))
}

// convert a price string to a float
function normalizePrice(price) {
  if (price === '__.__€') {
    return null
  }

  return parseFloat(price.replace('€', '').trim())
}

/**
 * Converts a string to a Date
 * @param {string} date "Juin 2016"
 * @returns Date
 */
function normalizeDate(date) {
  const months = {
    Janvier: '01',
    Février: '02',
    Mars: '03',
    Avril: '04',
    Mai: '05',
    Juin: '06',
    Juillet: '07',
    Août: '08',
    Septembre: '09',
    Octobre: '10',
    Novembre: '11',
    Décembre: '12'
  }
  const [month, year] = date.split(' ')

  return new Date(year + '-' + months[month] + '-01T00:00:00')
}
