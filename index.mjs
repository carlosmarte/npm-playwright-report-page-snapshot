// main.mjs
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";
import { v4 as uuidv4 } from "uuid";
import tls from "tls";

// Load data.json
const dataPath = path.join(
  dirname(fileURLToPath(import.meta.url)),
  "testcases/developer.chrome.new.json"
);
const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));

// Handle default exports correctly in ESM
const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

/**
 * WebAutomator - Advanced tool for detailed website analysis using Playwright
 * Provides comprehensive analysis of a single URL with detailed reporting
 */
export class WebAutomator {
  /**
   * Create a new WebAutomator instance
   * @param {import('playwright').Page} page - Playwright page instance
   */
  constructor(page) {
    this.page = page;
    this.__dirname = dirname(fileURLToPath(import.meta.url));

    // Initialize central state management
    this.state = {
      // Core state
      url: null,
      outputDir: "./reports",
      screenshotDir: "./screenshots",
      testId: uuidv4(),
      timestamp: new Date()
        .toISOString()
        .replace(/:/g, "-")
        .replace(/\..+/, ""),

      // Browser monitoring
      browser: {
        resourceRequest: [],
        errors: [],
        message: [],
        spy: [],
      },

      // Analysis data
      analysisData: {},
      screenshots: [],
      custom: [], // Array to store custom function results

      // Report paths
      reportPath: null,
      screenshotReportPath: null,
    };

    // Configuration defaults
    this.config = {
      onLoadCaptureVariables: [],
      listenToWindowVariables: [],
      listenToWindowFunctions: [],
      logEval: true,
      logFunctionCreation: false,
      intervalTime: 100,
      maxWaitTime: 10000,
    };
  }

  /**
   * Run the automation for a single URL
   * @param {Object} options - Configuration options
   * @returns {Promise<Object>} Results of the automation
   */
  async run(options) {
    try {
      // Merge options with defaults
      this.mergeOptions(options);

      // Create output directories
      this.createDirectories();

      // Setup browser monitoring
      await this.setupBrowserMonitoring();

      console.log(`\n🔍 Processing URL: ${this.state.url}`);

      try {
        // Navigate to the URL and analyze
        await this.navigateToPage(this.state.url);

        // Run all analysis methods
        await this.analyzePage();

        // Capture SSL certificate info if configured
        if (options.captureSSL) {
          await this.captureSSL(
            typeof options.captureSSL === "object" ? options.captureSSL : {}
          );
        }

        if (options.captureBrowserCookies) {
          await this.captureBrowserCookies(
            typeof options.captureBrowserCookies === "object"
              ? options.captureBrowserCookies
              : {}
          );
        }

        if (options.captureBlockingLoadedResources) {
          this.state.analysisData.browserResources =
            await this.captureBlockingLoadedResources({
              resourceTypes: ["script", "stylesheet", "image", "font"],
              timeout: 15000, // Collect resources for 15 seconds
            });
        }

        // Run accessibility scan if configured
        if (options.accessibilityScan) {
          console.log(`🔍 Running accessibility scan`);
          try {
            const runScan = await this.accessibilityScan(
              typeof options.accessibilityScan === "object"
                ? options.accessibilityScan
                : {}
            );
            const axeBuilder = await import("@axe-core/playwright").then(
              (module) => new module.default({ page: this.page })
            );
            const results = await runScan(axeBuilder);
            this.state.analysisData.accessibility = results;
          } catch (error) {
            console.error(`❌ Accessibility scan error: ${error.message}`);
            this.state.analysisData.accessibility = {
              error: error.message,
              stack: error.stack,
            };
          }
        }

        // Collect all links on the page
        await this.collectLinks();

        console.log(`✅ Analysis complete`);
      } catch (error) {
        console.error(`❌ Error processing URL: ${error.message}`);
        this.recordError(error);
      }

      return {
        testId: this.state.testId,
        url: this.state.url,
        outputDir: this.state.outputDir,
        timestamp: this.state.timestamp,
        reports: {
          main: this.state.reportPath,
          screenshots: this.state.screenshotReportPath,
        },
        analysisData: this.state.analysisData,
        browser: this.browser,
        page: this.page,
        custom: this.state.custom, // Include custom results in return value
      };
    } catch (error) {
      console.error(`❌ Automation failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Collect all links on the page
   * @returns {Promise<Array>} Array of link objects
   */
  async collectLinks() {
    try {
      console.log("🔗 Collecting links from the page");

      const links = await this.page.evaluate(() => {
        return Array.from(document.querySelectorAll("a")).map((link) => ({
          href: link.href,
          text: link.textContent.trim(),
          title: link.title || null,
          target: link.target || null,
          rel: link.rel || null,
          isExternal: link.hostname !== window.location.hostname,
          hasImage: link.querySelector("img") !== null,
          attributes: Object.fromEntries(
            Array.from(link.attributes)
              .filter(
                (attr) =>
                  !["href", "text", "title", "target", "rel"].includes(
                    attr.name
                  )
              )
              .map((attr) => [attr.name, attr.value])
          ),
        }));
      });

      console.log(`✅ Collected ${links.length} links`);

      // Store links in analysis data
      this.state.analysisData.links = links;

      return links;
    } catch (error) {
      console.error(`❌ Error collecting links: ${error.message}`);
      this.state.analysisData.links = [];
      return [];
    }
  }

  /**
   * Merge provided options with defaults
   * @param {Object} options - User options
   */
  mergeOptions(options) {
    // Validate and set URL
    if (!options.url) {
      throw new Error("URL must be provided");
    }
    this.state.url = options.url;

    // Set directories
    if (options.outputDir) this.state.outputDir = options.outputDir;
    if (options.screenshotDir) this.state.screenshotDir = options.screenshotDir;

    // Set monitoring configuration
    if (options.onLoadCaptureVariables)
      this.config.onLoadCaptureVariables = options.onLoadCaptureVariables;
    if (options.listenToWindowVariables)
      this.config.listenToWindowVariables = options.listenToWindowVariables;
    if (options.listenToWindowFunctions)
      this.config.listenToWindowFunctions = options.listenToWindowFunctions;

    // Other config options
    if (typeof options.logEval === "boolean")
      this.config.logEval = options.logEval;
    if (typeof options.logFunctionCreation === "boolean")
      this.config.logFunctionCreation = options.logFunctionCreation;
    if (options.intervalTime) this.config.intervalTime = options.intervalTime;
    if (options.maxWaitTime) this.config.maxWaitTime = options.maxWaitTime;

    // Request context (initial state)
    if (options.requestContext) {
      Object.assign(this.state.browser, options.requestContext.browser || {});
      if (options.requestContext.windowVariables)
        this.state.windowVariables = options.requestContext.windowVariables;
      if (options.requestContext.domTree)
        this.state.domTree = options.requestContext.domTree;
    }

    // Store custom execution functions
    if (options.execute && Array.isArray(options.execute)) {
      this.customFunctions = options.execute;
    }
  }

  /**
   * Create necessary directories for storing outputs
   */
  createDirectories() {
    // Create the main output directory
    const runDir = path.join(this.state.outputDir, this.state.timestamp);
    fs.mkdirSync(runDir, { recursive: true });
    this.state.outputDir = runDir;

    // Create screenshot directory
    const screenshotDir = path.join(runDir, "screenshots");
    fs.mkdirSync(screenshotDir, { recursive: true });
    this.state.screenshotDir = screenshotDir;

    console.log(`\n📂 Created output directory: ${runDir}`);
    console.log(`📸 Screenshots will be saved to: ${screenshotDir}`);
  }

  /**
   * Record an error in the analysis data
   * @param {Error} error - Error object
   */
  recordError(error) {
    this.state.analysisData.error = {
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Navigate to a page with resilient error handling
   * @param {string} url - URL to navigate to
   * @returns {Promise<string>} - Final URL after navigation
   */
  async navigateToPage(url) {
    console.log(`Navigating to: ${url}`);

    try {
      // Set timeout for navigation
      this.page.setDefaultNavigationTimeout(30000);

      // Navigate to the page with some basic wait conditions
      await this.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      console.log(`- DOM content loaded`);

      // Allow some time for resources to load
      await this.page.waitForTimeout(5000);

      console.log(`- Navigation completed`);
      return url;
    } catch (error) {
      console.log(`⚠️ Navigation issue: ${error.message}`);

      // Try to continue with whatever loaded
      console.log(`- Attempting to continue with partial page load`);
      return url;
    }
  }

  /**
   * Set up all browser monitoring features
   * @returns {Promise<void>}
   */
  async setupBrowserMonitoring() {
    await Promise.all([
      this.setupConsoleListener(),
      this.setupResourceInterceptor(),
      this.injectSpyScript(),
    ]);
  }

  /**
   * Set up console message listener
   * @returns {Promise<void>}
   */
  async setupConsoleListener() {
    this.page.on("console", async (msg) => {
      try {
        const text = msg.text();

        // Skip known security errors about sandboxing
        if (
          text.includes("Blocked script execution") &&
          text.includes("sandboxed")
        ) {
          return;
        }

        // Record errors specially
        if (msg.type() === "error") {
          this.state.browser.errors.push([msg.type(), text]);
          console.log(`[BrowserConsole][${msg.type()}]:`, text);
          return;
        }

        // Try to get the actual arguments
        const args = await Promise.all(
          msg.args().map(async (arg) => {
            try {
              return await arg.jsonValue();
            } catch (e) {
              return "[Frame Detached]";
            }
          })
        );

        // Log and store console messages
        console.log(`[BrowserConsole][${msg.type()}]:`, ...args);
        this.state.browser.message.push([msg.type(), args]);
      } catch (err) {
        console.warn("Error processing console message:", err);
      }
    });
  }

  /**
   * Set up resource request interception
   * @returns {Promise<void>}
   */
  async setupResourceInterceptor() {
    await this.page.route("**/*.js", async (route, request) => {
      const url = request.url();
      console.log("Intercepted JS:", url);
      this.state.browser.resourceRequest.push(url);

      // Try to match local file
      const urlPath = new URL(url).pathname;
      const localPath = path.resolve(this.__dirname, "source-codes", urlPath);

      // Check if path should be enhanced
      if (
        Object.keys(this.getEnhanceListener()).some((key) =>
          urlPath.includes(key)
        )
      ) {
        await this.handleEnhancedScript(route, url, urlPath);
      } else if (fs.existsSync(localPath)) {
        await this.serveLocalFile(route, localPath);
      } else {
        console.info(`Local file not found: ${localPath}`);
        await route.continue();
      }
    });
  }

  /**
   * Handle enhanced script injection
   * @param {Object} route - Playwright route
   * @param {string} url - Original URL
   * @param {string} urlPath - URL path
   * @returns {Promise<void>}
   */
  async handleEnhancedScript(route, url, urlPath) {
    const enhanceListener = this.getEnhanceListener();
    const matchedKey = Object.keys(enhanceListener).find((key) =>
      urlPath.includes(key)
    );
    console.log(`Using enhanced handler for ${url} with key ${matchedKey}`);

    let originalSourceCode;
    const localPath = path.resolve(this.__dirname, "source-codes", urlPath);

    // Try to get source from local file first
    if (fs.existsSync(localPath)) {
      originalSourceCode = fs.readFileSync(localPath, "utf8");
    } else {
      // Otherwise, fetch the original source from the network
      const response = await fetch(url);
      originalSourceCode = await response.text();
    }

    // Apply the enhancement
    const enhancedCode = enhanceListener[matchedKey](
      originalSourceCode,
      urlPath
    );

    await route.fulfill({
      status: 200,
      contentType: this.getMimeType(urlPath).contentType,
      body: enhancedCode,
    });
  }

  /**
   * Serve a local file
   * @param {Object} route - Playwright route
   * @param {string} localPath - Path to local file
   * @returns {Promise<void>}
   */
  async serveLocalFile(route, localPath) {
    console.log("Using local file for", localPath);
    const body = fs.readFileSync(localPath, "utf8");
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body,
    });
  }

  /**
   * Get the MIME type for a file
   * @param {string} filePath - File path
   * @returns {Object} - MIME type object
   */
  getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      ".js": "application/javascript",
      ".css": "text/css",
      ".html": "text/html",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
    };
    return { contentType: mimeTypes[ext] || "application/octet-stream" };
  }

  /**
   * Get the enhance listener map from data.json
   * @returns {Object} - Map of file paths to handler functions
   */
  getEnhanceListener() {
    // Get enhance listeners from data.json
    const enhanceListeners = data.enhanceListeners || {};

    // Convert string function definitions to actual functions
    const result = {};

    for (const [key, handlerStr] of Object.entries(enhanceListeners)) {
      try {
        // Create a function from the string definition
        result[key] = (originalSourceCode, urlPath) => {
          // Create a function that has access to this context and the traceFunctionCalls method
          const handler = new Function(
            "originalSourceCode",
            "urlPath",
            "traceFunctionCalls",
            `
            console.log("Enhancing script: " + urlPath);
            ${handlerStr}
            `
          );

          return handler(
            originalSourceCode,
            urlPath,
            this.traceFunctionCalls.bind(this)
          );
        };
      } catch (error) {
        console.error(`Error creating enhance listener for ${key}:`, error);
        // Provide a fallback that just returns the original code
        result[key] = (originalSourceCode) => originalSourceCode;
      }
    }

    return result;
  }

  /**
   * Inject spy script into the page
   * @returns {Promise<void>}
   */
  async injectSpyScript() {
    try {
      // Inject into the main frame
      await this.injectSpyIntoFrame(this.page.mainFrame());

      // Listen for new frames
      this.page.on("frameattached", async (frame) => {
        await this.injectSpyIntoFrame(frame);
      });

      this.page.on("framenavigated", async (frame) => {
        await this.injectSpyIntoFrame(frame);
      });
    } catch (err) {
      console.warn("Error setting up spy script:", err.message);
    }
  }

  /**
   * Inject spy script into a frame
   * @param {Object} frame - Playwright frame
   * @returns {Promise<void>}
   */
  async injectSpyIntoFrame(frame) {
    try {
      const url = frame.url();
      if (!url || url.startsWith("about:blank") || url.startsWith("data:")) {
        console.log(`[Skip Inject] Frame ${frame.name()} invalid URL: ${url}`);
        return;
      }

      console.log(`[Injecting Spy] into frame URL: ${url}`);

      // Options for the spy script
      const spyOptions = {
        ...this.config,
        state: this.state.browser, // For recording spy events
      };

      await frame.evaluate(this.getSpyScriptFunction(), spyOptions);
    } catch (err) {
      console.warn(`[Error Injecting Spy]:`, err.message);
    }
  }

  /**
   * Get the spy script function
   * @returns {Function} - Spy script function for browser evaluation
   */
  getSpyScriptFunction() {
    return (options = {}) => {
      console.log("[SPY] Initialized with options:", options);

      // Extract options with defaults
      const listenToWindowVariables = options.listenToWindowVariables || [];
      const listenToWindowFunctions = options.listenToWindowFunctions || [];
      const intervalTime = options.intervalTime || 100;
      const maxWaitTime = options.maxWaitTime || 10000;

      try {
        // ========== Wrap Function and Eval ========== //
        window.Function = new Proxy(window.Function, {
          construct(target, args) {
            if (options.logFunctionCreation) {
              try {
                options.state.spy.push([
                  "[SPY] Function constructor called with:",
                  args,
                ]);

                console.log("[SPY] Function constructor called with:", args);
              } catch (e) {
                console.log("[SPY] Error logging function creation:", e);
              }
            }
            return new target(...args);
          },
        });

        window.eval = new Proxy(window.eval, {
          apply(target, thisArg, args) {
            if (options.logEval) {
              try {
                options.state.spy.push(["[SPY] eval called:", args]);
                console.log("[SPY] eval called:", args);
              } catch (e) {
                console.log("[SPY] Error logging eval call:", e);
              }
            }
            return Reflect.apply(target, thisArg, args);
          },
        });

        let wrappedItems = new Set();
        let intervals = {};

        // Helper to get an object by path
        function getObjectByPath(path) {
          try {
            const parts = path.split(".");
            let obj = window;
            let currentPath = "";

            for (let i = 0; i < parts.length; i++) {
              const part = parts[i];
              currentPath = currentPath ? `${currentPath}.${part}` : part;

              if (obj === undefined || obj === null) {
                return {
                  exists: false,
                  obj: undefined,
                  property: part,
                  parent: null,
                  fullPath: currentPath,
                };
              }

              if (i === parts.length - 1) {
                // This is the final property we want to access
                return {
                  exists: part in obj,
                  obj: obj[part],
                  property: part,
                  parent: obj,
                  fullPath: currentPath,
                };
              }

              obj = obj[part];
            }

            return {
              exists: false,
              obj: undefined,
              property: "",
              parent: null,
              fullPath: path,
            };
          } catch (error) {
            console.log(`[SPY] Error in getObjectByPath for ${path}:`, error);
            return {
              exists: false,
              obj: undefined,
              property: "",
              parent: null,
              fullPath: path,
              error: error.message,
            };
          }
        }

        // Function to wrap an object property (function or value)
        function wrapProperty(path) {
          try {
            const { exists, obj, property, parent, fullPath } =
              getObjectByPath(path);

            if (!exists || !parent) {
              return false;
            }

            // Already wrapped?
            if (wrappedItems.has(fullPath)) {
              return true;
            }

            if (typeof obj === "function") {
              // Handle function
              const original = parent[property];
              parent[property] = new Proxy(original, {
                apply(target, thisArg, args) {
                  try {
                    console.log(`[SPY] ${fullPath} called with:`, args);
                    options.state.spy.push([
                      `[SPY] ${fullPath} called with:`,
                      args,
                    ]);
                  } catch (e) {
                    console.log(`[SPY] Error logging function call:`, e);
                  }
                  return Reflect.apply(target, thisArg, args);
                },
              });
              wrappedItems.add(fullPath);
              console.log(
                `[SPY_EVENT] Successfully wrapped function: ${fullPath}`
              );
              return true;
            } else {
              // Handle non-function (use getter/setter if possible)
              try {
                // Get property descriptor to preserve existing getter/setter if any
                const descriptor = Object.getOwnPropertyDescriptor(
                  parent,
                  property
                );

                if (descriptor && (descriptor.get || descriptor.set)) {
                  // Property has getter/setter
                  const originalGet = descriptor.get;
                  const originalSet = descriptor.set;

                  Object.defineProperty(parent, property, {
                    get: function () {
                      try {
                        const value = originalGet
                          ? originalGet.call(this)
                          : undefined;
                        options.state.spy.push([
                          `[SPY] Getting ${fullPath}:`,
                          value,
                        ]);
                        console.log(`[SPY] Getting ${fullPath}:`, value);
                        return value;
                      } catch (e) {
                        console.log(`[SPY] Error in getter:`, e);
                        return originalGet ? originalGet.call(this) : undefined;
                      }
                    },
                    set: function (newValue) {
                      try {
                        console.log(`[SPY] Setting ${fullPath} to:`, newValue);
                        options.state.spy.push([
                          `[SPY] Setting ${fullPath} to:`,
                          typeof newValue === "object"
                            ? JSON.stringify(newValue)
                            : newValue,
                        ]);
                      } catch (e) {
                        console.log(`[SPY] Error in setter:`, e);
                      }
                      if (originalSet) originalSet.call(this, newValue);
                    },
                    enumerable: descriptor.enumerable,
                    configurable: descriptor.configurable,
                  });
                } else {
                  // Regular property
                  let value = parent[property];
                  Object.defineProperty(parent, property, {
                    get: function () {
                      try {
                        console.log(`[SPY] Getting ${fullPath}:`, value);
                        options.state.spy.push([
                          `[SPY] Getting ${fullPath}:`,
                          value,
                        ]);
                      } catch (e) {
                        console.log(`[SPY] Error in get:`, e);
                      }
                      return value;
                    },
                    set: function (newValue) {
                      try {
                        console.log(`[SPY] Setting ${fullPath} to:`, newValue);
                        options.state.spy.push([
                          `[SPY] Setting ${fullPath} to:`,
                          typeof newValue === "object"
                            ? JSON.stringify(newValue)
                            : newValue,
                        ]);
                      } catch (e) {
                        console.log(`[SPY] Error in set:`, e);
                      }
                      value = newValue;
                    },
                    enumerable: true,
                    configurable: true,
                  });
                }

                wrappedItems.add(fullPath);
                console.log(
                  `[SPY_EVENT] Successfully wrapped property: ${fullPath}`
                );
                return true;
              } catch (err) {
                console.error(
                  `[SPY] Error wrapping property ${fullPath}:`,
                  err
                );
                return false;
              }
            }
          } catch (error) {
            console.log(`[SPY] Error wrapping property:`, error);
            return false;
          }
        }

        // Set up wrappers with intervals for delayed objects
        if (Array.isArray(listenToWindowVariables)) {
          listenToWindowVariables.forEach((path) => {
            // Try wrapping immediately
            const wrapped = wrapProperty(path);

            if (!wrapped) {
              // If not successful, set up interval to try again
              console.log(`[SPY_EVENT] Setting up interval for ${path}`);

              intervals[path] = setInterval(() => {
                try {
                  const success = wrapProperty(path);

                  if (success) {
                    console.log(
                      `[SPY_EVENT] Successfully wrapped ${path} after waiting`
                    );
                    clearInterval(intervals[path]);
                    delete intervals[path];
                  }
                } catch (e) {
                  console.log(`[SPY] Error in interval for ${path}:`, e);
                }
              }, intervalTime);

              // Safety cleanup
              setTimeout(() => {
                if (intervals[path]) {
                  clearInterval(intervals[path]);
                  delete intervals[path];
                  console.log(
                    `[SPY_EVENT] Stopped trying to wrap ${path} after timeout`
                  );
                }
              }, maxWaitTime);
            }
          });
        }

        // ========== Spy Specific Functions ========== //
        function createSpy(obj, name) {
          try {
            return new Proxy(obj, {
              apply(target, thisArg, argumentsList) {
                try {
                  console.log(
                    `[SPY] Function ${name} called with:`,
                    argumentsList
                  );
                } catch (e) {
                  console.log(`[SPY] Error logging function call:`, e);
                }
                return Reflect.apply(target, thisArg, argumentsList);
              },
              get(target, prop, receiver) {
                const value = Reflect.get(target, prop, receiver);
                if (typeof value === "function") {
                  return createSpy(value, `${name}.${prop.toString()}`);
                }
                return value;
              },
            });
          } catch (error) {
            console.log(`[SPY] Error creating spy for ${name}:`, error);
            return obj; // Return original if we can't spy
          }
        }

        if (listenToWindowFunctions) {
          // Wrap functions from keyword list
          listenToWindowFunctions.forEach((keyword) => {
            try {
              if (typeof window[keyword] === "function") {
                console.log(`[SPY] Wrapping function: ${keyword}`);
                window[keyword] = createSpy(window[keyword], keyword);
              }
            } catch (err) {
              console.error(`[SPY] Error wrapping ${keyword}:`, err);
            }
          });
        }
      } catch (e) {
        console.log("[SPY] Critical error in spy script:", e);
      }

      // Return success status
      return { initialized: true, options };
    };
  }

  /**
   * Adds function call tracing to JavaScript code
   * @param {Object} options - Options for function tracing
   * @returns {string} Modified JavaScript code
   */
  traceFunctionCalls(options = {}) {
    // Validate input
    if (!options) {
      throw new Error("Options object is required");
    }

    const { sourceCode, filename = "anonymous", filter = [] } = options;

    if (!sourceCode || typeof sourceCode !== "string") {
      throw new Error("Source code must be a non-empty string");
    }

    // Parse the source code into an AST
    const ast = parse(sourceCode, {
      sourceType: "module",
      plugins: [
        "jsx",
        "typescript",
        "classProperties",
        "classPrivateProperties",
        "decorators-legacy",
      ],
      // Enable location data
      locations: true,
    });

    // Function to check if a function name should be processed based on filter
    const shouldProcessFunction = (name) => {
      if (!filter || filter.length === 0) return true;
      return filter.includes(name);
    };

    // Create console log statement for a function with location info
    const createConsoleLogStatement = (
      functionName,
      argsName = "arguments",
      loc
    ) => {
      const locationStr = loc
        ? `${filename}:${loc.start.line}:${loc.start.column}`
        : filename;

      return t.expressionStatement(
        t.callExpression(
          t.memberExpression(t.identifier("console"), t.identifier("log")),
          [
            t.stringLiteral(`[${locationStr}] ${functionName}`),
            t.identifier(argsName),
          ]
        )
      );
    };

    // Create console count statement for a function with location info
    const createConsoleCountStatement = (
      functionName,
      argsName = "arguments",
      loc
    ) => {
      const locationStr = loc
        ? `${filename}:${loc.start.line}:${loc.start.column}`
        : filename;

      return t.expressionStatement(
        t.callExpression(
          t.memberExpression(t.identifier("console"), t.identifier("count")),
          [
            t.templateLiteral(
              [
                t.templateElement({ raw: "[", cooked: "[" }),
                t.templateElement({ raw: "] ", cooked: "] " }),
                t.templateElement({ raw: "-", cooked: "-" }),
                t.templateElement({ raw: "", cooked: "" }, true),
              ],
              [
                t.stringLiteral(locationStr),
                t.stringLiteral(functionName),
                t.callExpression(
                  t.memberExpression(
                    t.identifier("JSON"),
                    t.identifier("stringify")
                  ),
                  [t.identifier(argsName)]
                ),
              ]
            ),
          ]
        )
      );
    };

    // Add logging statements to a function body
    const addLoggingToFunction = (
      path,
      functionName,
      argsName = "arguments"
    ) => {
      if (!shouldProcessFunction(functionName)) return;

      const loc = path.node.loc;
      const consoleLogStatement = createConsoleLogStatement(
        functionName,
        argsName,
        loc
      );
      const consoleCountStatement = createConsoleCountStatement(
        functionName,
        argsName,
        loc
      );

      path
        .get("body")
        .unshiftContainer("body", [consoleLogStatement, consoleCountStatement]);
    };

    // Create a variable declaration for storing parameters in arrow functions
    const createArgsArray = (params) => {
      const paramIdentifiers = params.map((param) => {
        if (t.isIdentifier(param)) {
          return t.identifier(param.name);
        }
        return t.identifier("undefined");
      });

      return t.variableDeclaration("const", [
        t.variableDeclarator(
          t.identifier("_args"),
          t.arrayExpression(paramIdentifiers)
        ),
      ]);
    };

    // Traverse the AST and modify function declarations and expressions
    traverse(ast, {
      // For named function declarations: function name() {}
      FunctionDeclaration(path) {
        const functionName = path.node.id ? path.node.id.name : "anonymous";
        addLoggingToFunction(path, functionName);
      },

      // For function expressions: const name = function() {}
      FunctionExpression(path) {
        let functionName = path.node.id ? path.node.id.name : "anonymous";

        // Try to determine function name from context
        if (
          path.parent.type === "VariableDeclarator" &&
          path.parent.id.type === "Identifier"
        ) {
          functionName = path.parent.id.name;
        } else if (
          path.parent.type === "AssignmentExpression" &&
          path.parent.left.type === "MemberExpression" &&
          path.parent.left.property.type === "Identifier"
        ) {
          functionName = path.parent.left.property.name;
        } else if (
          path.parent.type === "ObjectProperty" &&
          path.parent.key.type === "Identifier"
        ) {
          functionName = path.parent.key.name;
        }

        addLoggingToFunction(path, functionName);
      },

      // For arrow functions: const name = () => {}
      ArrowFunctionExpression(path) {
        let functionName = "anonymous";

        // Try to determine function name from context
        if (
          path.parent.type === "VariableDeclarator" &&
          path.parent.id.type === "Identifier"
        ) {
          functionName = path.parent.id.name;
        } else if (
          path.parent.type === "AssignmentExpression" &&
          path.parent.left.type === "MemberExpression" &&
          path.parent.left.property.type === "Identifier"
        ) {
          functionName = path.parent.left.property.name;
        } else if (
          path.parent.type === "ObjectProperty" &&
          path.parent.key.type === "Identifier"
        ) {
          functionName = path.parent.key.name;
        }

        if (!shouldProcessFunction(functionName)) return;

        const loc = path.node.loc;

        // For arrow functions with block bodies
        if (t.isBlockStatement(path.node.body)) {
          const argsArray = createArgsArray(path.node.params);
          const consoleLogStatement = createConsoleLogStatement(
            functionName,
            "_args",
            loc
          );
          const consoleCountStatement = createConsoleCountStatement(
            functionName,
            "_args",
            loc
          );

          path
            .get("body")
            .unshiftContainer("body", [
              argsArray,
              consoleLogStatement,
              consoleCountStatement,
            ]);
        }
        // For arrow functions with expression bodies, convert to block body
        else {
          const returnValue = path.node.body;

          const argsArray = createArgsArray(path.node.params);
          const consoleLogStatement = createConsoleLogStatement(
            functionName,
            "_args",
            loc
          );
          const consoleCountStatement = createConsoleCountStatement(
            functionName,
            "_args",
            loc
          );
          const returnStatement = t.returnStatement(returnValue);

          // Replace the expression body with a block body containing our statements
          path.node.body = t.blockStatement([
            argsArray,
            consoleLogStatement,
            consoleCountStatement,
            returnStatement,
          ]);
        }
      },

      // For class methods
      ClassMethod(path) {
        const methodName =
          path.node.key.name ||
          (path.node.key.type === "StringLiteral"
            ? path.node.key.value
            : "anonymous");
        let className = "AnonymousClass";

        // Try to find class name
        const classParent = path.findParent(
          (p) => p.isClassDeclaration() || p.isClassExpression()
        );
        if (classParent && classParent.node.id) {
          className = classParent.node.id.name;
        }

        const functionName = `${className}.${methodName}`;

        if (
          !shouldProcessFunction(functionName) &&
          !shouldProcessFunction(methodName)
        )
          return;

        addLoggingToFunction(path, functionName);
      },

      // For object methods
      ObjectMethod(path) {
        const methodName =
          path.node.key.name ||
          (path.node.key.type === "StringLiteral"
            ? path.node.key.value
            : "anonymous");

        if (!shouldProcessFunction(methodName)) return;

        addLoggingToFunction(path, methodName);
      },
    });

    // Generate code from the modified AST
    const output = generate(ast, {
      retainLines: true,
      comments: true,
    });

    return output.code;
  }

  /**
   * Analyze the current page
   * @returns {Promise<Object>} Analysis data
   */
  async analyzePage() {
    try {
      // Perform all analysis in parallel for efficiency
      const [
        htmlStructure,
        resources,
        domObjects,
        interactivity,
        performanceMetrics,
        windowVariables,
        screenshot,
        domTree,
      ] = await Promise.all([
        this.collectHtmlStructure(),
        this.collectLoadedResources(),
        this.collectDomObjects(),
        this.testInteractivity(),
        this.collectPerformanceMetrics(),
        this.captureWindowVariables(),
        this.takeScreenshot(),
        this.createDomTree(),
      ]);

      // Store all collected data in state
      Object.assign(this.state.analysisData, {
        url: await this.page.url(),
        html: htmlStructure,
        resources,
        domObjects,
        interactivity,
        performanceMetrics,
        windowVariables,
        timestamp: new Date().toISOString(),
        domTree,
      });

      // Store screenshot information separately
      if (screenshot && screenshot.path) {
        const screenshotId = this.state.screenshots.length;
        this.state.screenshots.push(screenshot);
        this.state.analysisData.screenshotId = screenshotId;
      }

      return this.state.analysisData;
    } catch (error) {
      console.error(`Error analyzing page:`, error.message);

      // Record the error and return empty data
      this.recordError(error);
      return this.state.analysisData;
    }
  }

  /**
   * Capture SSL certificate information for the current page
   * @param {Object} options - Options for SSL capture
   * @param {boolean} [options.includeCertificateChain=false] - Whether to include the full certificate chain
   * @param {boolean} [options.includeRawCertificate=false] - Whether to include the raw certificate data
   * @returns {Promise<Object>} Certificate information
   */
  async captureSSL(options = {}) {
    try {
      console.log("🔒 Capturing SSL certificate information");

      // Merge with default options
      const sslOptions = {
        includeCertificateChain: options.includeCertificateChain || false,
        includeRawCertificate: options.includeRawCertificate || false,
      };

      // Get current URL
      const url = await this.page.url();
      if (!url.startsWith("https://")) {
        return {
          error: "Not an HTTPS URL",
          url,
          secure: false,
          timestamp: new Date().toISOString(),
        };
      }

      // Parse URL to get hostname
      const hostname = new URL(url).hostname;

      // Helper function to safely parse certificate dates
      const parseCertDate = (dateString) => {
        try {
          // Handle ASN.1 TIME format which might cause the invalid time error
          // Format could be: YYMMDDHHMMSSZ or YYYYMMDDHHMMSSZ

          if (typeof dateString !== "string") {
            return new Date().toISOString(); // Fallback for invalid input
          }

          // Try direct parsing first
          const directDate = new Date(dateString);
          if (!isNaN(directDate.getTime())) {
            return directDate.toISOString();
          }

          // If direct parsing fails, try to parse the ASN.1 format
          // Extract components from ASN.1 TIME format
          let year, month, day, hour, minute, second;

          if (dateString.length === 13) {
            // YYMMDDHHMMSSZ format
            year = parseInt(dateString.substr(0, 2));
            // Adjust 2-digit year (assume 20YY for now)
            year = year < 50 ? 2000 + year : 1900 + year;
            month = parseInt(dateString.substr(2, 2)) - 1; // JS months are 0-based
            day = parseInt(dateString.substr(4, 2));
            hour = parseInt(dateString.substr(6, 2));
            minute = parseInt(dateString.substr(8, 2));
            second = parseInt(dateString.substr(10, 2));
          } else if (dateString.length === 15) {
            // YYYYMMDDHHMMSSZ format
            year = parseInt(dateString.substr(0, 4));
            month = parseInt(dateString.substr(4, 2)) - 1;
            day = parseInt(dateString.substr(6, 2));
            hour = parseInt(dateString.substr(8, 2));
            minute = parseInt(dateString.substr(10, 2));
            second = parseInt(dateString.substr(12, 2));
          } else {
            // For other formats, fall back to current date
            return new Date().toISOString();
          }

          const date = new Date(year, month, day, hour, minute, second);
          return !isNaN(date.getTime())
            ? date.toISOString()
            : new Date().toISOString();
        } catch (e) {
          console.warn(`Error parsing certificate date: ${dateString}`, e);
          return new Date().toISOString(); // Fallback
        }
      };

      // Create a Promise to handle the async socket connection
      const certInfoPromise = new Promise((resolve, reject) => {
        try {
          // Parse host and port from URL
          const parsedUrl = new URL(url);
          const host = parsedUrl.hostname;
          const port = parsedUrl.port ? parseInt(parsedUrl.port) : 443;

          console.log(
            `Connecting to ${host}:${port} for certificate information`
          );

          // Connect using TLS to get certificate info
          const socket = tls.connect(
            {
              host,
              port,
              servername: host, // Important for SNI
              rejectUnauthorized: false, // We want to inspect even invalid certs
              timeout: 10000, // 10 second timeout
            },
            () => {
              try {
                // Get the certificate with full chain if requested
                const cert = socket.getPeerCertificate(
                  sslOptions.includeCertificateChain
                );

                // For logging/debugging
                console.log(
                  `Certificate date format - validFrom: ${typeof cert.validFrom} - ${
                    cert.validFrom
                  }`
                );
                console.log(
                  `Certificate date format - validTo: ${typeof cert.validTo} - ${
                    cert.validTo
                  }`
                );

                // Safely parse dates
                const validFrom = parseCertDate(cert.validFrom);
                const validTo = parseCertDate(cert.validTo);

                // Calculate days remaining
                const daysRemaining = Math.floor(
                  (new Date(validTo) - new Date()) / (1000 * 60 * 60 * 24)
                );

                // Basic formatted result
                const result = {
                  valid: socket.authorized,
                  issuer: cert.issuer,
                  subject: cert.subject,
                  validFrom,
                  validTo,
                  fingerprint: cert.fingerprint,
                  serialNumber: cert.serialNumber,
                  daysRemaining,
                  hostname,
                  url,
                  secure: socket.authorized,
                  protocol: socket.getProtocol(),
                  cipher: socket.getCipher(),
                  timestamp: new Date().toISOString(),
                };

                // Add raw certificate if requested
                if (sslOptions.includeRawCertificate) {
                  result.rawCertificate = cert;
                }

                // Add certificate chain if requested and available
                if (
                  sslOptions.includeCertificateChain &&
                  cert.issuerCertificate
                ) {
                  result.certificateChain = [];
                  let currentCert = cert;

                  // Walk up the certificate chain
                  while (
                    currentCert.issuerCertificate &&
                    !currentCert.issuerCertificate.fingerprint ===
                      currentCert.fingerprint
                  ) {
                    const chainCert = currentCert.issuerCertificate;
                    result.certificateChain.push({
                      issuer: chainCert.issuer,
                      subject: chainCert.subject,
                      validFrom: parseCertDate(chainCert.validFrom),
                      validTo: parseCertDate(chainCert.validTo),
                      fingerprint: chainCert.fingerprint,
                    });

                    currentCert = chainCert;

                    // Prevent infinite loop in case of circular references
                    if (result.certificateChain.length > 10) break;
                  }
                }

                socket.end();
                resolve(result);
              } catch (error) {
                socket.end();
                reject(
                  new Error(
                    `Error extracting certificate information: ${error.message}`
                  )
                );
              }
            }
          );

          socket.on("error", (error) => {
            reject(new Error(`TLS connection error: ${error.message}`));
          });

          socket.on("timeout", () => {
            socket.end();
            reject(new Error("TLS connection timeout"));
          });
        } catch (error) {
          reject(
            new Error(`Error setting up TLS connection: ${error.message}`)
          );
        }
      });

      // Wait for the certificate info
      const certificateInfo = await certInfoPromise;

      // Store certificate info in analysis data
      this.state.analysisData.sslCertificate = certificateInfo;

      console.log(`✅ SSL certificate captured for ${hostname}`);
      console.log(`   Valid from: ${certificateInfo.validFrom}`);
      console.log(`   Valid to: ${certificateInfo.validTo}`);
      console.log(`   Days remaining: ${certificateInfo.daysRemaining}`);

      return certificateInfo;
    } catch (error) {
      console.error(`❌ Error capturing SSL certificate: ${error.message}`);

      // Add error information to analysis data
      this.state.analysisData.sslCertificate = {
        error: error.message,
        url: await this.page.url(),
        timestamp: new Date().toISOString(),
        secure: false,
      };

      return {
        error: error.message,
        url: await this.page.url(),
        timestamp: new Date().toISOString(),
        secure: false,
      };
    }
  }

  /**
   * Prepare and configure an accessibility scan using AxeBuilder
   * @param {Object} options - Options for the accessibility scan
   * @returns {Function} Function that executes the accessibility scan when called
   */
  async accessibilityScan(options = {}) {
    try {
      console.log("🔍 Setting up accessibility scan with AxeBuilder");

      // Import AxeBuilder dynamically
      const { default: AxeBuilder } = await import("@axe-core/playwright");

      if (!AxeBuilder) {
        throw new Error(
          "Failed to import @axe-core/playwright. Make sure it's installed."
        );
      }

      // Initialize the AxeBuilder
      let axeBuilder = new AxeBuilder({ page: this.page });

      // Configure the scan based on options
      if (options.disableRules && Array.isArray(options.disableRules)) {
        console.log(`- Disabling rules: ${options.disableRules.join(", ")}`);
        axeBuilder = axeBuilder.disableRules(options.disableRules);
      }

      if (options.exclude) {
        const excludeSelectors = Array.isArray(options.exclude)
          ? options.exclude
          : [options.exclude];
        console.log(`- Excluding selectors: ${excludeSelectors.join(", ")}`);
        excludeSelectors.forEach((selector) => {
          axeBuilder = axeBuilder.exclude(selector);
        });
      }

      if (options.withTags && Array.isArray(options.withTags)) {
        console.log(`- Including tags: ${options.withTags.join(", ")}`);
        axeBuilder = axeBuilder.withTags(options.withTags);
      }

      if (options.include) {
        const includeSelectors = Array.isArray(options.include)
          ? options.include
          : [options.include];
        console.log(`- Including selectors: ${includeSelectors.join(", ")}`);
        includeSelectors.forEach((selector) => {
          axeBuilder = axeBuilder.include(selector);
        });
      }

      // Create and return the runner function
      const runScan = async (axeBuilder) => {
        try {
          console.log(`⚡ Running accessibility scan`);

          const scanStartTime = Date.now();
          const results = await axeBuilder.analyze();
          const scanDuration = Date.now() - scanStartTime;

          console.log(
            `✅ Accessibility scan complete. Found ${results.violations.length} violations in ${scanDuration}ms`
          );

          return {
            violations: results.violations,
            passes: results.passes,
            incomplete: results.incomplete,
            inapplicable: results.inapplicable,
            timestamp: new Date().toISOString(),
            url: await this.page.url(),
            scanDuration,
          };
        } catch (error) {
          console.error(`❌ Accessibility scan failed: ${error.message}`);
          throw error;
        }
      };

      return runScan;
    } catch (error) {
      console.error(`❌ Error setting up accessibility scan: ${error.message}`);
      throw error;
    }
  }

  /**
   * Capture blocking and non-blocking resources loaded on the page
   * @param {Object} options - Configuration options for resource tracking
   * @returns {Promise<Object>} Information about blocking and non-blocking resources
   */
  async captureBlockingLoadedResources(options = {}) {
    try {
      const resourceTypes = options.resourceTypes || [
        "script",
        "stylesheet",
        "image",
        "font",
        "fetch",
      ];
      const timeout = options.timeout || 10000;

      console.log(
        `🔍 Capturing blocking and non-blocking resources for ${timeout}ms`
      );
      console.log(`   Tracking resource types: ${resourceTypes.join(", ")}`);

      // Storage for resources
      const resources = {
        blocking: [],
        nonBlocking: [],
        resourcesById: new Map(),
        summary: {
          blocking: { count: 0, totalBytes: 0, totalDuration: 0 },
          nonBlocking: { count: 0, totalBytes: 0, totalDuration: 0 },
        },
      };

      // Create a CDP session for detailed network monitoring
      const client = await this.page.context().newCDPSession(this.page);

      // Enable necessary domains
      await client.send("Network.enable");
      await client.send("Performance.enable");

      // Map to store request start times
      const requestStartTimes = new Map();

      // Setup event listeners
      client.on("Network.requestWillBeSent", (event) => {
        try {
          const { requestId, request, initiator, timestamp } = event;

          // Skip non-tracked resource types
          const resourceType =
            request.resourceType || this.getResourceTypeFromUrl(request.url);
          if (!resourceTypes.includes(resourceType)) return;

          // Store request start time
          requestStartTimes.set(requestId, timestamp);

          // Store initial request info
          resources.resourcesById.set(requestId, {
            id: requestId,
            url: request.url,
            type: resourceType,
            initiator: initiator.type,
            startTime: timestamp,
            blocking: this.isBlockingResource(resourceType, request.url),
            status: "pending",
            size: 0,
            duration: 0,
          });
        } catch (err) {
          console.warn(`Error in requestWillBeSent handler: ${err.message}`);
        }
      });

      client.on("Network.responseReceived", (event) => {
        try {
          const { requestId, response, timestamp } = event;
          if (!resources.resourcesById.has(requestId)) return;

          const resource = resources.resourcesById.get(requestId);
          resource.status = response.status;
          resource.mimeType = response.mimeType;
          resource.responseTime = timestamp;
          resource.timing = response.timing;
        } catch (err) {
          console.warn(`Error in responseReceived handler: ${err.message}`);
        }
      });

      client.on("Network.loadingFinished", (event) => {
        try {
          const { requestId, timestamp, encodedDataLength } = event;
          if (!resources.resourcesById.has(requestId)) return;

          const resource = resources.resourcesById.get(requestId);
          const startTime =
            requestStartTimes.get(requestId) || resource.startTime;

          // Calculate duration in milliseconds
          resource.duration = (timestamp - startTime) * 1000; // Convert to ms
          resource.size = encodedDataLength;
          resource.endTime = timestamp;

          // Add to appropriate list
          if (resource.blocking) {
            resources.blocking.push(resource);
            resources.summary.blocking.count++;
            resources.summary.blocking.totalBytes += encodedDataLength;
            resources.summary.blocking.totalDuration += resource.duration;
          } else {
            resources.nonBlocking.push(resource);
            resources.summary.nonBlocking.count++;
            resources.summary.nonBlocking.totalBytes += encodedDataLength;
            resources.summary.nonBlocking.totalDuration += resource.duration;
          }
        } catch (err) {
          console.warn(`Error in loadingFinished handler: ${err.message}`);
        }
      });

      client.on("Network.loadingFailed", (event) => {
        try {
          const { requestId, timestamp, errorText } = event;
          if (!resources.resourcesById.has(requestId)) return;

          const resource = resources.resourcesById.get(requestId);
          resource.status = "failed";
          resource.error = errorText;
          resource.endTime = timestamp;

          // Calculate duration
          const startTime =
            requestStartTimes.get(requestId) || resource.startTime;
          resource.duration = (timestamp - startTime) * 1000; // Convert to ms

          // Add to appropriate list
          if (resource.blocking) {
            resources.blocking.push(resource);
            resources.summary.blocking.count++;
          } else {
            resources.nonBlocking.push(resource);
            resources.summary.nonBlocking.count++;
          }
        } catch (err) {
          console.warn(`Error in loadingFailed handler: ${err.message}`);
        }
      });

      // Use route interception for more detailed tracking
      await this.page.route("**/*", async (route, request) => {
        try {
          const url = request.url();
          const resourceType = request.resourceType();

          // Allow the request to continue
          await route.continue();

          // Log the interception if it's a tracked resource type
          if (resourceTypes.includes(resourceType)) {
            console.log(`Intercepted ${resourceType}: ${url}`);
          }
        } catch (err) {
          console.warn(`Error in route handler: ${err.message}`);
          await route.continue().catch(() => {});
        }
      });

      // Wait for the specified timeout to collect resources
      await this.page.waitForTimeout(timeout);

      // Clean up interception
      await this.page.unroute("**/*");

      // Calculate average metrics
      if (resources.summary.blocking.count > 0) {
        resources.summary.blocking.avgSize = Math.round(
          resources.summary.blocking.totalBytes /
            resources.summary.blocking.count
        );
        resources.summary.blocking.avgDuration = Math.round(
          resources.summary.blocking.totalDuration /
            resources.summary.blocking.count
        );
      }

      if (resources.summary.nonBlocking.count > 0) {
        resources.summary.nonBlocking.avgSize = Math.round(
          resources.summary.nonBlocking.totalBytes /
            resources.summary.nonBlocking.count
        );
        resources.summary.nonBlocking.avgDuration = Math.round(
          resources.summary.nonBlocking.totalDuration /
            resources.summary.nonBlocking.count
        );
      }

      // Build the final response
      const result = {
        blocking: resources.blocking,
        nonBlocking: resources.nonBlocking,
        summary: resources.summary,
        timestamp: new Date().toISOString(),
        url: await this.page.url(),
      };

      console.log(`✅ Resource capture complete`);
      console.log(`   Blocking resources: ${result.summary.blocking.count}`);
      console.log(
        `   Non-blocking resources: ${result.summary.nonBlocking.count}`
      );

      return result;
    } catch (error) {
      console.error(`❌ Error capturing resources: ${error.message}`);
      return {
        error: error.message,
        blocking: [],
        nonBlocking: [],
        summary: {
          blocking: { count: 0 },
          nonBlocking: { count: 0 },
        },
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Determine if a resource is blocking based on its type and URL
   * @param {string} resourceType - Type of the resource
   * @param {string} url - URL of the resource
   * @returns {boolean} Whether the resource is considered render blocking
   */
  isBlockingResource(resourceType, url) {
    // CSS in the head and synchronous scripts are render-blocking
    if (resourceType === "stylesheet") {
      return true;
    }

    if (resourceType === "script") {
      // Check for async/defer patterns in URL (commonly used in file naming)
      if (url.includes("async") || url.includes("defer")) {
        return false;
      }

      // Typically analytics and tracking scripts are non-blocking
      if (
        url.includes("analytics") ||
        url.includes("tracking") ||
        url.includes("gtm.") ||
        url.includes("ga.") ||
        url.includes("pixel") ||
        url.includes("tracker")
      ) {
        return false;
      }

      // By default, consider scripts as blocking
      return true;
    }

    // Fonts can block rendering if not optimized
    if (resourceType === "font") {
      return true;
    }

    // Images, fetch, XHR, etc. are typically non-blocking
    return false;
  }

  /**
   * Try to determine resource type from URL if not provided
   * @param {string} url - URL of the resource
   * @returns {string} Best guess at resource type
   */
  getResourceTypeFromUrl(url) {
    const extension = url
      .split("?")[0]
      .split("#")[0]
      .split(".")
      .pop()
      .toLowerCase();

    const extensionMap = {
      js: "script",
      css: "stylesheet",
      png: "image",
      jpg: "image",
      jpeg: "image",
      gif: "image",
      svg: "image",
      ico: "image",
      woff: "font",
      woff2: "font",
      ttf: "font",
      eot: "font",
      json: "fetch",
      html: "document",
      htm: "document",
    };

    return extensionMap[extension] || "other";
  }

  /**
   * Capture all browser cookies from the current page
   * @param {Object} options - Options for cookie capture
   * @returns {Promise<Array>} Array of cookie objects
   */
  async captureBrowserCookies(options = {}) {
    try {
      console.log("📋 Capturing browser cookies");

      // Set default options
      const cookieOptions = {
        includeHttpOnly: options.includeHttpOnly || false,
        includeSecure: options.includeSecure !== false, // Default to true
        domain: options.domain || null,
        path: options.path || null,
      };

      // Use CDP to get all cookies (includes HttpOnly if enabled)
      let cookies;

      if (cookieOptions.includeHttpOnly) {
        // Use CDP to get all cookies including HttpOnly
        const client = await this.page.context().newCDPSession(this.page);
        const response = await client.send("Network.getAllCookies");
        cookies = response.cookies;

        // Filter if needed
        if (cookieOptions.domain) {
          cookies = cookies.filter(
            (cookie) =>
              cookie.domain && cookie.domain.includes(cookieOptions.domain)
          );
        }

        if (cookieOptions.path) {
          cookies = cookies.filter(
            (cookie) => cookie.path && cookie.path === cookieOptions.path
          );
        }

        if (!cookieOptions.includeSecure) {
          cookies = cookies.filter((cookie) => !cookie.secure);
        }
      } else {
        // Use standard Playwright API (doesn't include HttpOnly)
        const url = await this.page.url();
        const contextCookies = await this.page.context().cookies(url);

        cookies = contextCookies;

        // Apply filters
        if (cookieOptions.domain) {
          cookies = cookies.filter(
            (cookie) =>
              cookie.domain && cookie.domain.includes(cookieOptions.domain)
          );
        }

        if (cookieOptions.path) {
          cookies = cookies.filter(
            (cookie) => cookie.path && cookie.path === cookieOptions.path
          );
        }

        if (!cookieOptions.includeSecure) {
          cookies = cookies.filter((cookie) => !cookie.secure);
        }
      }

      // Store cookies in the analysis data
      this.state.analysisData.browserCookies = cookies;

      console.log(`✅ Captured ${cookies.length} cookies`);
      return cookies;
    } catch (error) {
      console.error(`❌ Error capturing cookies: ${error.message}`);
      return [];
    }
  }

  /**
   * Add a mock function to the page before navigation
   * @param {string} path - Notation path from window (e.g., 'navigator.getBattery')
   * @param {Object|Function} returnValue - Value or function to return when the mock is called
   * @returns {Promise<void>}
   */
  async addInitialMockFunction(path, returnValue) {
    console.log(`Adding initial mock function for: ${path}`);

    try {
      // Extract function name and parent object path
      const parts = path.split(".");
      const functionName = parts.pop();
      const parentPath = parts.join(".");

      // Generate proper JavaScript for the mock
      let mockCode;

      if (typeof returnValue === "function") {
        // For function return values, we stringify the function
        const functionStr = returnValue.toString();
        mockCode = `
        (() => {
          const mockFn = ${functionStr};
          const pathParts = '${parentPath}'.split('.');
          let target = window;
          
          // Navigate to the parent object
          for (const part of pathParts) {
            if (part) {
              if (!target[part]) {
                target[part] = {};
              }
              target = target[part];
            }
          }
          
          // Override the function
          target['${functionName}'] = mockFn;
          console.log('[MOCK] Successfully mocked ${path}');
        })();
      `;
      } else {
        // For values, we serialize to JSON
        const valueStr = JSON.stringify(returnValue);
        mockCode = `
        (() => {
          const mockValue = ${valueStr};
          const pathParts = '${parentPath}'.split('.');
          let target = window;
          
          // Navigate to the parent object
          for (const part of pathParts) {
            if (part) {
              if (!target[part]) {
                target[part] = {};
              }
              target = target[part];
            }
          }
          
          // For object return values, create a function that returns the mock
          target['${functionName}'] = ${
          parts.length > 0 ? "async" : ""
        } () => mockValue;
          console.log('[MOCK] Successfully mocked ${path}');
        })();
      `;
      }

      // Add the script to execute on page initialization
      await this.page.addInitScript(mockCode);
      console.log(`✅ Mock function added for: ${path}`);

      return true;
    } catch (error) {
      console.error(`❌ Error adding mock function: ${error.message}`);
      return false;
    }
  }

  /**
   * Add a mock route to intercept and handle requests
   * @param {string|RegExp} urlPattern - URL pattern to match for interception
   * @param {Object|Function} handler - Handler for the route
   * @param {string} [method='GET'] - HTTP method to mock
   * @returns {Promise<void>}
   */
  async addMockRoute(urlPattern, handler, method = "GET") {
    console.log(`Adding mock route for: ${urlPattern} (${method})`);

    try {
      // If the handler is an object, create a function that returns it
      let routeHandler;

      if (typeof handler === "function") {
        routeHandler = handler;
      } else {
        // For object handlers, fulfill with the object as JSON
        routeHandler = async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(handler),
          });
        };
      }

      // Add the route with an optional method filter
      await this.page.route(urlPattern, async (route, request) => {
        // Only handle requests with the specified method
        if (request.method() !== method) {
          await route.continue();
          return;
        }

        console.log(`Intercepted ${method} request to: ${request.url()}`);
        await routeHandler(route, request);
      });

      console.log(`✅ Mock route added for: ${urlPattern}`);
    } catch (error) {
      console.error(`❌ Error adding mock route: ${error.message}`);
      throw error;
    }
  }

  /**
   * Enable video recording for the browser context
   * @param {Object} options - Video recording options
   * @returns {Promise<void>}
   */
  async enableVideoRecording(options = {}) {
    try {
      // Get current viewport for default dimensions if needed
      const viewportSize = this.page.viewportSize() || {
        width: 1280,
        height: 720,
      };

      // Set up video recording options with defaults
      const videoOptions = {
        dir: options.dir || path.join(this.state.outputDir, "videos"),
        size: {
          width: options.width || viewportSize.width,
          height: options.height || viewportSize.height,
        },
      };

      // Create video directory if it doesn't exist
      fs.mkdirSync(videoOptions.dir, { recursive: true });

      console.log(`📹 Enabling video recording to ${videoOptions.dir}`);
      console.log(
        `   Video dimensions: ${videoOptions.size.width}x${videoOptions.size.height}`
      );

      // We need to create a new context with video recording enabled
      const context = this.page.context();

      // Store the current page URL to navigate back after creating new context
      const currentUrl = this.page.url();

      // Create a new browser context with video recording enabled
      const newContext = await context.browser().newContext({
        recordVideo: videoOptions,
        viewport: viewportSize,
        userAgent: await this.page.evaluate(() => navigator.userAgent),
        bypassCSP: true,
        ignoreHTTPSErrors: true,
        javaScriptEnabled: true,
        locale: "en-US",
      });

      // Create a new page in the recording-enabled context
      const newPage = await newContext.newPage();

      // Navigate to the current URL if we're on a real page
      if (currentUrl && !currentUrl.startsWith("about:")) {
        await newPage.goto(currentUrl, { waitUntil: "domcontentloaded" });
      }

      // Replace the current page with the new recording-enabled page
      this.page = newPage;

      // Update state to track video recording
      this.state.videoRecording = {
        enabled: true,
        options: videoOptions,
        context: newContext,
      };

      return videoOptions;
    } catch (error) {
      console.error(`❌ Error enabling video recording: ${error.message}`);
      throw error;
    }
  }

  /**
   * Collect HTML structure of the page
   * @returns {Promise<Object>} The HTML structure data
   */
  async collectHtmlStructure() {
    try {
      const htmlStructure = await this.page.evaluate(() => {
        // Collect headings
        const headings = {};
        ["h1", "h2", "h3", "h4", "h5", "h6"].forEach((tag) => {
          headings[tag] = Array.from(document.querySelectorAll(tag)).map((el) =>
            el.textContent.trim()
          );
        });

        // Collect paragraphs
        const paragraphs = Array.from(document.querySelectorAll("p")).map(
          (el) => el.textContent.trim()
        );

        // Navigation structure
        const navStructure = document.querySelector("nav")
          ? Array.from(document.querySelectorAll("nav a")).map((a) => ({
              text: a.textContent.trim(),
              href: a.getAttribute("href"),
            }))
          : [];

        return {
          title: document.title,
          headings,
          paragraphs,
          navStructure,
        };
      });

      return htmlStructure;
    } catch (error) {
      console.log(`⚠️ Error collecting HTML structure: ${error.message}`);
      return {
        title: "Error collecting data",
        headings: {},
        paragraphs: [],
        navStructure: [],
      };
    }
  }

  /**
   * Collect loaded resources on the page
   * @returns {Promise<Object>} The resource data
   */
  async collectLoadedResources() {
    const resources = {
      scripts: [],
      stylesheets: [],
      images: [],
      fonts: [],
      other: [],
    };

    try {
      // Set up a listener for network requests
      const client = await this.page.context().newCDPSession(this.page);
      await client.send("Network.enable");

      // Collect resources for a fixed amount of time
      const collectDuration = 3000; // Just collect for 3 seconds max
      console.log(`Collecting resources for ${collectDuration}ms`);

      let requestListener = (event) => {
        try {
          if (!event.response) return;

          const { type, url, status } = event.response;
          const resourceObj = {
            url,
            status,
            mimeType: event.response.mimeType,
            size: event.response.encodedDataLength || 0,
          };

          // Categorize resources by type
          switch (type) {
            case "Script":
              resources.scripts.push(resourceObj);
              break;
            case "Stylesheet":
              resources.stylesheets.push(resourceObj);
              break;
            case "Image":
              resources.images.push(resourceObj);
              break;
            case "Font":
              resources.fonts.push(resourceObj);
              break;
            default:
              resources.other.push(resourceObj);
          }
        } catch (err) {
          // Ignore errors in the listener
        }
      };

      client.on("Network.responseReceived", requestListener);

      // Just wait a fixed amount of time rather than waiting for network idle
      await this.page.waitForTimeout(collectDuration);

      // Clean up
      client.removeListener("Network.responseReceived", requestListener);

      console.log(
        `Collected resources: ${resources.scripts.length} scripts, ` +
          `${resources.stylesheets.length} stylesheets, ` +
          `${resources.images.length} images`
      );

      return resources;
    } catch (error) {
      console.log(`⚠️ Error collecting resources: ${error.message}`);
      return resources; // Return empty structure
    }
  }

  /**
   * Collect DOM objects and statistics
   * @returns {Promise<Object>} The DOM objects data
   */
  async collectDomObjects() {
    try {
      const domObjects = await this.page.evaluate(() => {
        // General DOM stats
        const stats = {
          totalElements: document.querySelectorAll("*").length,
        };

        // Element counts by tag
        const elementCounts = {};
        document.querySelectorAll("*").forEach((el) => {
          const tagName = el.tagName.toLowerCase();
          elementCounts[tagName] = (elementCounts[tagName] || 0) + 1;
        });

        // IDs and classes in the document
        const ids = Array.from(document.querySelectorAll("[id]")).map(
          (el) => el.id
        );
        const classes = new Set();
        document.querySelectorAll("*").forEach((el) => {
          Array.from(el.classList).forEach((cls) => classes.add(cls));
        });

        // Detailed info about forms
        const forms = Array.from(document.querySelectorAll("form")).map(
          (form) => ({
            id: form.id,
            action: form.action,
            method: form.method,
            fieldsCount: form.querySelectorAll("input, select, textarea")
              .length,
          })
        );

        return {
          stats,
          elementCounts,
          forms,
          ids,
          classes: Array.from(classes),
        };
      });

      return domObjects;
    } catch (error) {
      console.log(`⚠️ Error collecting DOM objects: ${error.message}`);
      return {
        stats: { totalElements: 0 },
        elementCounts: {},
        forms: [],
        ids: [],
        classes: [],
      };
    }
  }

  /**
   * Test interactivity of page elements
   * @returns {Promise<Object>} The interactivity data
   */
  async testInteractivity() {
    const results = {
      clickable: [],
      forms: [],
      navigation: [],
    };

    try {
      // Test clickable elements
      const clickableSelectors = 'button, a, [onclick], [role="button"]';
      const clickables = await this.page.$$(clickableSelectors);

      for (const el of clickables) {
        try {
          const id = await el.evaluate((node) => node.id || null);
          const text = await el.evaluate(
            (node) => node.textContent.trim() || null
          );
          const type = await el.evaluate((node) => node.tagName.toLowerCase());

          // Save info about the clickable element
          results.clickable.push({
            id,
            text,
            type,
            visible: await el.isVisible(),
          });
        } catch (e) {
          // Element might have been detached, continue to next
        }
      }

      // Test form submissions (without actually submitting)
      const forms = await this.page.$$("form");
      for (const form of forms) {
        try {
          const id = await form.evaluate((node) => node.id || null);
          const action = await form.evaluate((node) => node.action || null);
          const fields = await form.$$("input, select, textarea");

          results.forms.push({
            id,
            action,
            fieldCount: fields.length,
            submitButton:
              (await form.$('button[type="submit"], input[type="submit"]')) !==
              null,
          });
        } catch (e) {
          // Skip problematic forms
        }
      }

      return results;
    } catch (error) {
      console.log(`⚠️ Error testing interactivity: ${error.message}`);
      return results;
    }
  }

  /**
   * Collect performance metrics from the page
   * @returns {Promise<Object>} The performance metrics data
   */
  async collectPerformanceMetrics() {
    try {
      // Basic performance metrics from Navigation Timing API
      const metrics = await this.page.evaluate(() => {
        if (!performance || !performance.getEntriesByType) return {};

        const navEntries = performance.getEntriesByType("navigation");
        if (!navEntries || navEntries.length === 0) return {};

        const perfEntries = navEntries[0];

        return {
          domContentLoaded:
            perfEntries.domContentLoadedEventEnd -
            perfEntries.domContentLoadedEventStart,
          load: perfEntries.loadEventEnd - perfEntries.loadEventStart,
          domInteractive: perfEntries.domInteractive,
          totalPageLoadTime: perfEntries.loadEventEnd,
          redirectCount: perfEntries.redirectCount,
        };
      });

      return metrics;
    } catch (error) {
      console.log(`⚠️ Error collecting performance metrics: ${error.message}`);
      return {};
    }
  }

  /**
   * Capture non-built-in window variables
   * @returns {Promise<Object>} Window variables data
   */
  async captureWindowVariables() {
    try {
      const windowVars = await this.page.evaluate(() => {
        // Create a new iframe to get a clean window object for comparison
        const iframe = document.createElement("iframe");
        iframe.style.display = "none";
        document.body.appendChild(iframe);

        const cleanWindow = iframe.contentWindow;

        // Get all properties from current window
        const currentWindowProperties = Object.getOwnPropertyNames(window);

        // Get all properties from clean window (built-in properties)
        const builtInProperties = Object.getOwnPropertyNames(cleanWindow);

        // Remove the iframe after getting the clean window properties
        document.body.removeChild(iframe);

        // Find custom properties (those not in the clean window)
        const customProperties = currentWindowProperties.filter(
          (prop) => !builtInProperties.includes(prop)
        );

        // Create result object with all custom properties
        const result = {};

        for (const prop of customProperties) {
          try {
            const value = window[prop];

            // Only include plain objects, arrays, and primitive values
            // Skip functions, DOM nodes, etc.
            if (
              value === null ||
              ["undefined", "boolean", "number", "string"].includes(
                typeof value
              ) ||
              Array.isArray(value) ||
              (typeof value === "object" &&
                value !== null &&
                Object.getPrototypeOf(value) === Object.prototype)
            ) {
              result[prop] = value;
            } else if (typeof value === "object") {
              // For complex objects, just store a placeholder with type info
              result[prop] = `[object ${Object.prototype.toString
                .call(value)
                .slice(8, -1)}]`;
            }
          } catch (error) {
            result[prop] = `[Error accessing property: ${error.message}]`;
          }
        }

        return result;
      });

      return windowVars;
    } catch (error) {
      console.log(`⚠️ Error capturing window variables: ${error.message}`);
      return {};
    }
  }

  /**
   * Create a DOM tree representation of HTML content
   * @returns {Promise<Object>} DOM tree data
   */
  async createDomTree() {
    try {
      return await this.page.evaluate(() => {
        /**
         * Creates a simplified tree representation of an element
         * @param {Element} element - DOM element
         * @param {number} maxDepth - Maximum depth to traverse
         * @param {number} currentDepth - Current depth in the traversal
         * @returns {Object} Tree representation of the element
         */
        function createElementTree(element, maxDepth = 20, currentDepth = 0) {
          if (!element || currentDepth > maxDepth) return null;

          // Base element info
          const result = {
            tagName: element.tagName.toLowerCase(),
            id: element.id || null,
            classList: Array.from(element.classList) || null,
          };

          // Add content if it's a text node or has text content
          if (element.nodeType === 3) {
            // Text node
            const text = element.nodeValue.trim();
            if (text) result.content = text;
          } else if (
            element.childNodes.length === 1 &&
            element.childNodes[0].nodeType === 3
          ) {
            // Element with only text content
            const text = element.textContent.trim();
            if (text) result.content = text;
          }

          // Add other important attributes
          if (element.hasAttributes()) {
            const attrObj = {};
            let hasAttrs = false;

            for (const attr of element.attributes) {
              // Skip class and id as they're already included
              if (attr.name !== "class" && attr.name !== "id") {
                attrObj[attr.name] = attr.value;
                hasAttrs = true;
              }
            }

            if (hasAttrs) result.attributes = attrObj;
          }

          // Process child elements
          if (element.childNodes.length > 0) {
            const children = [];

            for (const child of element.childNodes) {
              // Skip text nodes that are just whitespace
              if (child.nodeType === 3 && !child.nodeValue.trim()) continue;

              // For text nodes with content
              if (child.nodeType === 3 && child.nodeValue.trim()) {
                children.push({
                  type: "text",
                  content: child.nodeValue.trim(),
                });
                continue;
              }

              // Process element nodes
              if (child.nodeType === 1) {
                // Element node
                const childTree = createElementTree(
                  child,
                  maxDepth,
                  currentDepth + 1
                );
                if (childTree) children.push(childTree);
              }
            }

            if (children.length > 0) result.children = children;
          }

          return result;
        }

        // Get the DOM tree starting from the document element
        const docElement = document.documentElement;
        return createElementTree(docElement);
      });
    } catch (error) {
      console.log(`⚠️ Error creating DOM tree: ${error.message}`);
      return {
        error: error.message,
        stack: error.stack,
      };
    }
  }

  /**
   * Take a screenshot of the current page
   * @returns {Promise<Object>} Screenshot data
   */
  async takeScreenshot() {
    try {
      // Create a filename based on the URL
      let filename;
      try {
        const url = await this.page.url();
        const parsedUrl = new URL(url);
        const sanitizedPath = parsedUrl.pathname
          .replace(/\//g, "_")
          .replace(/[^a-z0-9_-]/gi, "");
        filename = `${sanitizedPath || "_home"}.png`;
      } catch (e) {
        // If URL parsing fails, use a timestamp
        filename = `screenshot_${Date.now()}.png`;
      }

      const screenshotPath = path.join(this.state.screenshotDir, filename);

      // Take the screenshot with increased timeout
      const buffer = await this.page.screenshot({
        fullPage: true,
        timeout: 30000,
      });

      // Save the screenshot to a file
      fs.writeFileSync(screenshotPath, buffer);
      console.log(`Screenshot saved to: ${screenshotPath}`);

      // Also return the base64 version for report
      const base64Screenshot = buffer.toString("base64");

      return {
        base64: base64Screenshot,
        path: screenshotPath,
        filename: filename,
      };
    } catch (error) {
      console.log(`⚠️ Error taking screenshot: ${error.message}`);

      // Return empty result without retrying
      return {
        base64: null,
        path: null,
        error: error.message,
      };
    }
  }

  /**
   * Generate and save the detailed reports
   * @returns {Promise<Object>} Paths to the generated reports
   */
  async generateAndSaveReports() {
    try {
      // Generate main analysis report
      const mainReport = this.generateMainReport();

      // Generate screenshot report
      const screenshotReport = this.generateScreenshotReport();

      // Generate paths for the reports
      const mainReportPath = path.join(
        this.state.outputDir,
        `${this.state.testId}.json`
      );

      const screenshotReportPath = path.join(
        this.state.outputDir,
        `${this.state.testId}-screenshots.json`
      );

      // Save the reports
      await fs.promises.writeFile(
        mainReportPath,
        JSON.stringify(mainReport, null, 2)
      );

      await fs.promises.writeFile(
        screenshotReportPath,
        JSON.stringify(screenshotReport, null, 2)
      );

      // Save paths in state
      this.state.reportPath = mainReportPath;
      this.state.screenshotReportPath = screenshotReportPath;

      // Generate an index file
      const indexPath = await this.createIndexFile();

      return {
        main: mainReportPath,
        screenshots: screenshotReportPath,
        index: indexPath,
      };
    } catch (error) {
      console.error(`Error generating reports: ${error.message}`);
      throw error;
    }
  }

  /**
   * Generate the main analysis report
   * @returns {Object} The report data
   */
  generateMainReport() {
    // Create base report structure
    const report = {
      testId: this.state.testId,
      timestamp: new Date().toISOString(),
      url: this.state.url,
      analysis: { ...this.state.analysisData },
      browser: {
        errors: this.state.browser.errors,
        messages: this.state.browser.message,
      },
      custom: this.state.custom, // Include custom results in the report
    };

    // Remove large datasets that will be stored separately
    if (report.analysis.screenshotId !== undefined) {
      // Keep the reference ID but remove base64 data
      delete report.analysis.screenshot;
    }

    // Prepare the report for JSON serialization (handle circular references)
    return this.sanitizeForJson(report);
  }

  /**
   * Generate the screenshot report
   * @returns {Object} The screenshot report data
   */
  generateScreenshotReport() {
    const screenshots = this.state.screenshots.map((screenshot, index) => ({
      id: index,
      filename: screenshot.filename || `screenshot_${index}.png`,
      path: screenshot.path,
      timestamp: new Date().toISOString(),
      base64: screenshot.base64 || null,
    }));

    return {
      testId: this.state.testId,
      timestamp: new Date().toISOString(),
      url: this.state.url,
      count: screenshots.length,
      screenshots,
    };
  }

  /**
   * Create an index file to track all reports
   * @returns {Promise<string>} Path to the index file
   */
  async createIndexFile() {
    try {
      const indexPath = path.join(this.state.outputDir, "index.json");

      // Create content for the index file
      const indexContent = {
        testId: this.state.testId,
        timestamp: this.state.timestamp,
        url: this.state.url,
        reports: {
          main: path.basename(this.state.reportPath),
          screenshots: path.basename(this.state.screenshotReportPath),
        },
        status: this.state.analysisData.error ? "error" : "success",
      };

      // Save the index file
      await fs.promises.writeFile(
        indexPath,
        JSON.stringify(indexContent, null, 2)
      );

      console.log(`📑 Created index file at: ${indexPath}`);
      return indexPath;
    } catch (error) {
      console.error(`❌ Error creating index file: ${error.message}`);
      return null;
    }
  }

  /**
   * Safely sanitize circular objects for JSON serialization
   * @param {Object} obj - Object to sanitize
   * @returns {Object} Safe object for JSON
   */
  sanitizeForJson(obj) {
    const seen = new WeakSet();

    const replacer = (key, value) => {
      // Skip properties that should be excluded entirely
      if (key === "_context" || key === "Provider") {
        return "[Excluded]";
      }

      // Handle non-object values
      if (typeof value !== "object" || value === null) {
        return value;
      }

      // Detect circular references
      if (seen.has(value)) {
        // Try to unwrap circular references by returning a simplified version
        if (Array.isArray(value)) {
          return `[Circular Array with ${value.length} items]`;
        }

        if (typeof value === "object") {
          // Create a simplified representation of the object's keys
          return `[Circular Object with keys: ${Object.keys(value).join(
            ", "
          )}]`;
        }

        return "[Circular Reference]";
      }

      // DOM nodes, errors, and other special objects
      if (
        value.nodeType === "number" ||
        (value.constructor && value.constructor.name === "Element")
      ) {
        return `[DOM Element: ${value.nodeName || "Unknown"}]`;
      }

      if (value instanceof Error) {
        return {
          message: value.message,
          stack: value.stack,
          name: value.name,
        };
      }

      // Track this object to detect circular references
      seen.add(value);
      return value;
    };

    // Use a try-catch approach for more robustness
    try {
      // First stringify then parse to create a deep copy with all circular refs resolved
      return JSON.parse(JSON.stringify(obj, replacer));
    } catch (err) {
      console.warn("Error during JSON sanitization:", err.message);

      // Fallback: use a more aggressive approach to handle problematic objects
      try {
        // Remove all potentially problematic properties first
        const simplified = {};
        for (const [key, value] of Object.entries(obj)) {
          if (
            value === null ||
            ["string", "number", "boolean", "undefined"].includes(
              typeof value
            ) ||
            (Array.isArray(value) && value.length < 1000) // Only include reasonably sized arrays
          ) {
            simplified[key] = value;
          } else if (typeof value === "object") {
            // For objects, include a type description instead of content
            simplified[key] = `[${
              Array.isArray(value) ? "Array" : "Object"
            }: too complex to serialize]`;
          }
        }
        return simplified;
      } catch (e) {
        console.error("Fatal error during JSON sanitization:", e);
        return {
          error: "Failed to serialize data",
          message: err.message,
        };
      }
    }
  }
}

/**
 * WebAutomatorChain - Chainable API for WebAutomator
 * Allows for fluent method chaining and custom function execution
 */
class WebAutomatorChain {
  /**
   * Create a new WebAutomatorChain
   * @param {Object} options - Configuration options
   * @param {import('playwright').Browser} browser - Playwright browser instance
   */
  constructor(options, browser) {
    this.options = options;
    this.browser = browser;
    this.results = null;
    this.customFunctions = options.execute || [];
    this.automator = null;
    this.context = null;
    this.page = null;
    return this;
  }

  /**
   * Run the standard report
   * @returns {Promise<WebAutomatorChain>} This instance for chaining
   */
  async runReport() {
    try {
      // Create a browser context
      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        bypassCSP: true,
        ignoreHTTPSErrors: true,
        javaScriptEnabled: true,
        locale: "en-US",
      });

      // Create a page
      this.page = await this.context.newPage();

      // Create and run the automator
      this.automator = new WebAutomator(this.page);
      this.results = await this.automator.run(this.options);

      return this;
    } catch (error) {
      console.error(`❌ Error running report: ${error.message}`);
      throw error;
    }
  }

  /**
   * Run a custom function with the current results
   * @param {Function} customFn - Custom function to run
   * @returns {Promise<WebAutomatorChain>} This instance for chaining
   */
  async runCustomFunction(customFn) {
    if (!customFn || typeof customFn !== "function") {
      console.warn("Invalid custom function provided, skipping");
      return this;
    }

    try {
      console.log(
        `🔧 Running custom function: ${customFn.name || "anonymous"}`
      );

      // Run the custom function with the current results and automator
      const customResult = await customFn({
        results: this.results,
        page: this.page,
        browser: this.browser,
        automator: this.automator,
      });

      // Add custom result to the state's custom array
      if (customResult) {
        this.automator.state.custom.push({
          name: customFn.name || `custom_${Date.now()}`,
          timestamp: new Date().toISOString(),
          data: customResult,
        });
      }

      return this;
    } catch (error) {
      console.error(`❌ Error in custom function: ${error.message}`);
      // Continue the chain despite errors
      return this;
    }
  }

  /**
   * Run all custom functions provided in options.execute
   * @returns {Promise<WebAutomatorChain>} This instance for chaining
   */
  async runAllCustomFunctions() {
    if (!this.customFunctions || !Array.isArray(this.customFunctions)) {
      return this;
    }

    for (const fn of this.customFunctions) {
      // Handle both function objects and function definitions in strings
      if (typeof fn === "function") {
        await this.runCustomFunction(fn);
      } else if (typeof fn === "object" && fn.code) {
        try {
          // Create a function from the code string
          const customFn = new Function("return " + fn.code)();
          // Set the name property if available
          if (fn.name) {
            Object.defineProperty(customFn, "name", { value: fn.name });
          }
          await this.runCustomFunction(customFn);
        } catch (error) {
          console.error(
            `❌ Error creating custom function from string: ${error.message}`
          );
        }
      }
    }

    return this;
  }

  /**
   * Close the browser and generate reports
   * @returns {Promise<WebAutomatorChain>} This instance for chaining
   */
  async close() {
    try {
      if (this.automator) {
        // Generate and save reports
        try {
          const reportPaths = await this.automator.generateAndSaveReports();
          console.log(`📊 Reports generated at:`);
          for (const [type, path] of Object.entries(reportPaths)) {
            console.log(`  - ${type}: ${path}`);
          }
        } catch (error) {
          console.error(`Error saving reports: ${error.message}`);
        }

        // Save video recording if enabled
        if (this.automator.state.videoRecording?.enabled) {
          console.log("📹 Saving video recording...");
          // Note: We'll handle this specially since we're closing the context below
        }

        console.log(
          `\n✅ Automation complete! Reports saved to: ${this.automator.state.outputDir}`
        );
      }

      // Close the context (which also saves any video recordings)
      if (this.context) {
        await this.context.close();

        // Log video recording completion if it was enabled
        if (this.automator?.state.videoRecording?.enabled) {
          console.log(
            "✅ Video saved to: " +
              this.automator.state.videoRecording.options.dir
          );
        }
      }

      // Close the browser if needed
      if (!this.options.keepBrowserOpen && this.browser) {
        await this.browser.close();
      }

      return this;
    } catch (error) {
      console.error(`❌ Error during close: ${error.message}`);
      // Try to close browser even if there was an error
      if (!this.options.keepBrowserOpen && this.browser) {
        try {
          await this.browser.close();
        } catch (e) {
          console.error(`Failed to close browser: ${e.message}`);
        }
      }
      throw error;
    }
  }

  /**
   * Get the final results
   * @returns {Object} The automation results
   */
  getResults() {
    return this.results;
  }

  /**
   * Convert the chain to a Promise that resolves with the results
   * @returns {Promise<Object>} Promise that resolves with the results
   */
  then(onFulfilled, onRejected) {
    return Promise.resolve(this.results).then(onFulfilled, onRejected);
  }

  /**
   * Handle Promise rejection
   * @param {Function} onRejected - Rejection handler
   * @returns {Promise<Object>} Promise
   */
  catch(onRejected) {
    return Promise.resolve(this.results).catch(onRejected);
  }

  /**
   * Handle Promise finally
   * @param {Function} onFinally - Finally handler
   * @returns {Promise<Object>} Promise
   */
  finally(onFinally) {
    return Promise.resolve(this.results).finally(onFinally);
  }
}

/**
 * Main entry point - run the automation with Playwright
 * @param {Object} options - Configuration options
 * @returns {Promise<WebAutomatorChain>} Promise resolving to chainable API for WebAutomator
 */
export async function main(options) {
  // Merge with default options from data.json
  const mergedOptions = {
    ...data.defaultOptions,
    ...options,
  };

  const browser = await chromium.launch({
    headless: mergedOptions.headless !== false,
  });

  const webAutomator = new WebAutomatorChain(mergedOptions, browser);

  await webAutomator.runReport();
  await webAutomator.runAllCustomFunctions();
  await webAutomator.close();

  return webAutomator;
}

// Example usage when running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const options = {
    url: process.argv[2] || data.defaultOptions.url,
    outputDir: "./reports",
    headless: false,
    captureSSL: true,
    captureBrowserCookies: true,
    captureBlockingLoadedResources: true,
    accessibilityScan: {
      withTags: ["wcag2a", "wcag2aa"],
      exclude: ".skip-accessibility",
    },
  };

  main(options).catch((error) => {
    console.error("Automation failed:", error);
    process.exit(1);
  });
}
