import { PACKAGE } from './host.js'
import { startBridge } from './session.js'
import { createChromiumDriver } from './chromium-driver.js'
import { createFirefoxDriver } from './firefox-driver.js'

const driver = PACKAGE.driver === 'firefox' ? createFirefoxDriver(PACKAGE) : createChromiumDriver(PACKAGE)
startBridge(driver, PACKAGE)
