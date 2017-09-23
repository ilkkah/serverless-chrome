/*
  Large portion of this is inspired by/taken from Lighthouse/chrome-launcher.
  It is Copyright Google Inc, licensed under Apache License, Version 2.0.
  https://github.com/GoogleChrome/lighthouse/blob/master/chrome-launcher/chrome-launcher.ts

  We ship a modified version because the original verion comes with too
  many dependencies which complicates packaging of serverless services.
*/

import path from 'path'
import fs from 'fs'
import { execSync, spawn } from 'child_process'
import net from 'net'
import { delay, debug, makeTempDir } from './utils'
import DEFAULT_CHROME_FLAGS from './flags'

const CHROME_PATH = path.resolve(__dirname, './headless_shell')
var PORT = 3000

export default class Launcher {
  constructor (options = {}) {
    const {
      chromePath = CHROME_PATH,
      chromeFlags = [],
      startingUrl = 'about:blank'
    } = options

    PORT = PORT + 1

    this.tmpDirandPidFileReady = false
    this.pollInterval = 500
    this.pidFile = ''
    this.startingUrl = 'about:blank'
    this.outFile = null
    this.errFile = null
    this.chromePath = CHROME_PATH
    this.chromeFlags = []
    this.userDataDir = ''
    this.port = PORT
    this.pid = null
    this.chrome = undefined
    this.client = undefined

    this.options = options
    this.startingUrl = startingUrl
    this.chromeFlags = chromeFlags
    this.chromePath = chromePath
  }

  get flags () {
    return [
      ...DEFAULT_CHROME_FLAGS,
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.userDataDir}`,
      '--disable-setuid-sandbox',
      ...this.chromeFlags,
      this.startingUrl,
    ]
  }

  prepare () {
    debug('prepare')
    this.userDataDir = this.options.userDataDir || makeTempDir()
    this.outFile = fs.openSync(`${this.userDataDir}/chrome-out.log`, 'a')
    this.errFile = fs.openSync(`${this.userDataDir}/chrome-err.log`, 'a')
    this.pidFile = `${this.userDataDir}/chrome.pid`
    this.tmpDirandPidFileReady = true
  }

  closed () {
    debug('** Chrome closed **', this.pid)
    delete this.chrome
    delete this.pid
    delete this.pidFile
    this.chrome = undefined
    this.pid = undefined
    this.pidFile = ''
  }

  // resolves if ready, rejects otherwise
  isReady () {
    return new Promise((resolve, reject) => {
      this.client = net.createConnection(this.port)

      this.client.once('error', (error) => {
        this.clearConnection()
        reject(error)
      })

      this.client.once('connect', () => {
        // clearConnection(client)
        resolve()
      })
    })
  }

  // resolves when debugger is ready, rejects after 10 polls
  waitUntilReady () {
    const launcher = this

    return new Promise((resolve, reject) => {
      let retries = 0
      ;(function poll () {
        debug('Waiting for Chrome', retries)

        launcher
          .isReady()
          .then(() => {
            debug('Started Chrome')
            resolve()
          })
          .catch((error) => {
            retries += 1

            if (retries > 10) {
              return reject(error)
            }

            return delay(launcher.pollInterval).then(poll)
          })
      }())
    })
  }

  async spawn () {
    const spawnPromise = new Promise(async (resolve) => {
      debug('spawn...', this.flags)

      if (this.chrome) {
        debug(`Chrome already running with pid ${this.chrome.pid}.`)
        return resolve(this.chrome.pid)
      }

      const chrome = spawn(this.chromePath, this.flags, {
        detached: true,
        stdio: ['ignore', this.outFile, this.errFile],
      })

      this.chrome = chrome

      chrome.on('close', this.closed)

      // unref the chrome instance, otherwise the lambda process won't end correctly
      if (chrome.chrome) {
        chrome.chrome.removeAllListeners()
        chrome.chrome.unref()
      }

      debug('Launcher', `Writing pidfile.`)

      fs.writeFileSync(this.pidFile, chrome.pid.toString())

      debug('Launcher', `Chrome running with pid ${chrome.pid} on port ${this.port}.`)

      return resolve(chrome.pid)
    })

    const pid = await spawnPromise
    await this.waitUntilReady()
    return pid
  }

  async launch () {
    debug('Launching Chrome', this.pid, this.chrome && this.chrome.pid)

    if (!this.tmpDirandPidFileReady) {
      this.prepare()
    }

    this.pid = await this.spawn()
    return Promise.resolve()
  }

  kill () {
    return new Promise((resolve) => {
      if (this.chrome) {
        this.chrome.on('close', () => {
          this.destroyTemp().then(resolve)
        })

        debug('Kill Chrome', this.chrome && this.chrome.pid)

        try {
          process.kill(-this.chrome.pid)
          this.clearConnection();
        } catch (err) {
          debug(`Chrome could not be killed ${err.message}`)
        }

        delete this.chrome
      } else {
        // fail silently as we did not start chrome
        resolve()
      }
    })
  }

  clearConnection () {
    if (this.client) {
      debug('** clearConnection **', this.pid, this.chrome && this.chrome.pid)
      this.client.removeAllListeners()
      this.client.end()
      this.client.destroy()
      this.client.unref()
    }
  }

  destroyTemp () {
    return new Promise((resolve) => {
      // Only clean up the tmp dir if we created it.
      if (this.userDataDir === undefined || this.options.userDataDir !== undefined) {
        return resolve()
      }

      if (this.outFile) {
        fs.closeSync(this.outFile)
        delete this.outFile
      }

      if (this.errFile) {
        fs.closeSync(this.errFile)
        delete this.errFile
      }

      return execSync(`rm -Rf ${this.userDataDir}`, resolve)
    })
  }
}
