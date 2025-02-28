import fetch from "node-fetch";
import WebSocket from "ws";
import { createSecureContext, connect } from "tls";
import { initiator } from "./initiator.mjs";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { logger, logLevel } from "./logger.mjs";
import { clearTerminal, sleep, writeListToTerminal } from "./helper.mjs";
import { bar } from "./progress.mjs";
import { FinderResult } from "../resources/subfinder.js";

// AbortController was added in node v14.17.0 globally
const AbortController = globalThis.AbortController;

export interface DomainResult {
  domain: string;
  ip?: string;
  statusCode: number;
  server: string;
}

export interface ProxyIPResult {
  domain: string;
  city: string;
  country: string;
  colo: string;
  proxyip: boolean;
}

export interface TlsResult {
  domain: string;
  tls: string;
}

class Scanner {
  private onFetch: Array<string> = [];

  async direct() {
    let result: Array<DomainResult> = [];
    let subDomains: Array<FinderResult> = [];

    subDomains = JSON.parse(readFileSync(`${initiator.path}/result/${initiator.domain}/subdomain.json`).toString());

    bar.start(subDomains.length, 1);
    clearTerminal();
    for (const i in subDomains) {
      this.onFetch.push(subDomains[i]?.domain || subDomains[i]?.ip);
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, 3000);

      // Fetch domain
      fetch(`http://${subDomains[i]?.domain || subDomains[i]?.ip}`, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "User-Agent": initiator.user_agent,
        },
      })
        .then((res) => {
          // Ignore server except cloudflare and cloudfront
          if (!res.headers.get("server")?.match(/^cloudf/i)) return;
          return result.push({
            domain: subDomains[i]?.domain,
            ip: subDomains[i]?.ip,
            statusCode: res.status,
            server: res.headers.get("server") as string,
          });
        })
        .catch((e: Error) => {
          // Error handler
        })
        .finally(() => {
          if (this.onFetch[0]) this.onFetch.shift();
          clearTimeout(timeout);
        });

      await new Promise(async (resolve) => {
        while (this.onFetch.length >= initiator.maxFetch) {
          // Wait for previous fetch to complete
          await sleep(200);
        }

        resolve(0);
      });

      const resultList = [`${logger.wrap(logLevel.info, "STATUS")} ${logger.wrap(logLevel.cloudfront, "DOMAIN")}`];
      for (const subDomain of result) {
        if (subDomain.server?.match(/cloudflare/i)) {
          resultList.push(
            `${logger.wrap(logLevel.cloudflare, String(subDomain.statusCode))}  ${logger.color(
              logLevel.cloudflare,
              subDomain.domain
            )}`
          );
        } else if (subDomain.server?.match(/cloudfront/i)) {
          resultList.push(
            `${logger.wrap(logLevel.cloudfront, String(subDomain.statusCode))}  ${logger.color(
              logLevel.cloudfront,
              subDomain.domain
            )}`
          );
        }
      }
      if (subDomains[parseInt(i) + 1]) {
        resultList.push(`${logger.wrap(logLevel.cloudflare, "CFlare")} ${logger.wrap(logLevel.cloudfront, "CFront")}`);
        resultList.push(
          `${logger.wrap(logLevel.info, "SCAN")}  ${
            subDomains[parseInt(i) + 1]?.domain || subDomains[parseInt(i) + 1]?.ip
          }`
        );
        resultList.push("");

        while (resultList.length > process.stdout.rows - 1) {
          resultList.splice(1, 1);
        }
        writeListToTerminal(resultList);
        bar.increment();
      }
    }

    // Wait for all fetch
    while (this.onFetch[0]) {
      await sleep(500);
    }
    bar.stop();

    writeFileSync(`${initiator.path}/result/${initiator.domain}/direct.json`, JSON.stringify(result, null, 2));
  }

  async cdn_ssl() {
    let result: Array<DomainResult> = [];
    const maxFetch = Math.round((initiator.cdn.cflare + initiator.cdn.cfront) / initiator.estScan) || 8;
    const cdns = JSON.parse(readFileSync(`${initiator.path}/result/${initiator.domain}/direct.json`).toString());

    bar.start(cdns.length, 1);
    clearTerminal();

    for (const i in cdns) {
      this.onFetch.push(cdns[i].domain);

      const ws = new WebSocket(`ws://${cdns[i].domain}`, {
        method: "GET",
        headers: {
          Host: initiator.host,
          Connection: "Upgrade",
          "User-Agent": initiator.user_agent,
          Upgrade: "websocket",
        },
        handshakeTimeout: 3000,
      });

      ws.on("open", () => {
        // Connection established
        ws.close(); // Close the connection immediately after opening
      });

      ws.on("error", (error: Error) => {
        if (error.message.match(/Unexpected server response: \d+$/)) {
          const responseCode = (error.message.match(/\d+$/) || [0])[0];
          if (responseCode == 101) {
            result.push({
              ...cdns[i],
              statusCode: responseCode,
            });
          }
        } else {
          logger.log(logLevel.error, `WebSocket error for ${cdns[i].domain}: ${error.message}`);
        }
      });

      ws.on("close", () => {
        if (this.onFetch[0]) this.onFetch.shift();
      });

      await new Promise(async (resolve) => {
        while (this.onFetch.length >= maxFetch) {
          // Wait for previous fetch to complete
          await sleep(500);
        }
        resolve(0);
      });

      const resultList = [`${logger.wrap(logLevel.info, "STATUS")} ${logger.wrap(logLevel.cloudfront, "DOMAIN")}`];
      for (const cdn of result) {
        resultList.push(
          `${cdn.statusCode == 101 ? logger.wrap(logLevel.success, cdn.statusCode.toString()) : cdn.statusCode}  ${
            cdn.server.match(/^cloudflare/i)
              ? logger.color(logLevel.cloudflare, cdn.domain)
              : logger.color(logLevel.cloudfront, cdn.domain)
          }`
        );
      }

      if (cdns[parseInt(i) + 1]) {
        resultList.push(`${logger.wrap(logLevel.cloudflare, "CFlare")} ${logger.wrap(logLevel.cloudfront, "CFront")}`);
        resultList.push(`${logger.wrap(logLevel.info, "SCAN")}  ${cdns[parseInt(i) + 1].domain}`);
        resultList.push("");

        while (resultList.length > process.stdout.rows - 1) {
          resultList.splice(1, 1);
        }
        writeListToTerminal(resultList);
        bar.increment();
      }
    }

    // Wait for all WebSocket connections to complete
    while (this.onFetch[0]) {
      await sleep(100);
    }
    bar.stop();

    // Save results
    const savePath = `${initiator.path}/result/${initiator.domain}`;
    if (!existsSync(savePath)) {
      mkdirSync(savePath, { recursive: true });
    }

    writeFileSync(`${savePath}/cdn.json`, JSON.stringify(result, null, 2));
    logger.log(logLevel.success, "CDN-SSL scan completed and results saved.");
  }

  async proxyIP() {
    let result: Array<ProxyIPResult> = [];
    let subDomains: Array<FinderResult> = [];

    subDomains = JSON.parse(readFileSync(`${initiator.path}/result/${initiator.domain}/subdomain.json`).toString());

    bar.start(subDomains.length, 1);
    clearTerminal();

    for (const i in subDomains) {
      const domain = subDomains[i].domain || subDomains[i].ip;
      this.onFetch.push(domain);

      const AbortController = globalThis.AbortController;
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, 5000);

      fetch(`https://cfip-check.pages.dev/api?ip=${domain}&host=cdn.onesignal.com&port=443&tls=true`, {
        signal: controller.signal,
      })
        .then(async (res) => {
          if (res.status == 200) {
            const data = (await res.json()) as any;
            if (data.proxyip) {
              result.push({
                domain: domain,
                city: data.City,
                country: data.loc,
                colo: data.colo,
                proxyip: data.proxyip,
              });
            }
          } else if (res.status == 429) {
            throw Error("too many request!");
          }
        })
        .catch((err: Error) => {
          if (err.message.match("too many request")) {
            throw err;
          } else if (!err.message.match("aborted")) {
            console.log(`Error Fetch ${domain}: ${err.message}`);
          }
        })
        .finally(() => {
          clearTimeout(timeout);
          if (this.onFetch[0]) this.onFetch.shift();
        });

      await new Promise(async (resolve) => {
        while (this.onFetch.length >= initiator.maxFetch) {
          // Wait for previous fetch to complete
          await sleep(500);
        }

        resolve(0);
      });

      const resultList = [`${logger.wrap(logLevel.info, "PROXY LOC")} ${logger.wrap(logLevel.cloudfront, "DOMAIN")}`];
      for (const subDomain of result) {
        resultList.push(`${logger.wrap(logLevel.success, subDomain.country || subDomain.colo)} : ${subDomain.domain}`);
      }

      if (subDomains[parseInt(i) + 1]) {
        resultList.push(
          `${logger.wrap(logLevel.info, "SCAN")}  ${
            subDomains[parseInt(i) + 1]?.domain || subDomains[parseInt(i) + 1]?.ip
          }`
        );
        resultList.push("");

        while (resultList.length > process.stdout.rows - 1) {
          resultList.splice(1, 1);
        }
        writeListToTerminal(resultList);
        bar.increment();
      }
    }

    // Wait for all fetch
    while (this.onFetch[0]) {
      await sleep(100);
    }
    bar.stop();

    writeFileSync(`${initiator.path}/result/${initiator.domain}/proxy.json`, JSON.stringify(result, null, 2));
  }

  async sni() {
    let result: Array<TlsResult> = [];
    const subDomains: Array<FinderResult> = JSON.parse(
      readFileSync(`${initiator.path}/result/${initiator.domain}/subdomain.json`).toString()
    );

    bar.start(subDomains.length, 1);
    clearTerminal();
    for (const i in subDomains) {
      this.onFetch.push(subDomains[i]?.domain || subDomains[i]?.ip);

      const socket = connect({
        host: initiator.v2host,
        port: 443,
        servername: subDomains[i]?.domain || subDomains[i]?.ip,
        rejectUnauthorized: false,
        secureContext: createSecureContext({
          maxVersion: "TLSv1.2",
        }),
      });

      socket.on("secureConnect", () => {
        const tls = socket.getProtocol()?.match(/(TLSv\d\.\d)$/);

        if (tls) {
          result.push({
            domain: subDomains[i]?.domain,
            tls: tls[0],
          });
        }
      });

      socket.on("error", (e) => {
        // Error handler
        socket.end();
      });

      socket.on("close", () => {
        if (this.onFetch[0]) this.onFetch.shift();
      });

      // Set timeout
      socket.setTimeout(3000, () => {
        socket.destroy();
      });

      await new Promise(async (resolve) => {
        while (this.onFetch.length >= initiator.maxFetch) {
          // Wait for previous fetch to complete
          await sleep(200);
        }

        resolve(0);
      });

      const resultList = [`${logger.wrap(logLevel.info, "PROTO")} ${logger.wrap(logLevel.cloudfront, "DOMAIN")}`];
      for (const subDomain of result) {
        resultList.push(`${logger.wrap(logLevel.success, subDomain.tls || "NULL")} : ${subDomain.domain}`);
      }

      if (subDomains[parseInt(i) + 1]) {
        resultList.push(
          `${logger.wrap(logLevel.info, "SCAN")}  ${
            subDomains[parseInt(i) + 1]?.domain || subDomains[parseInt(i) + 1]?.ip
          }`
        );
        resultList.push("");

        while (resultList.length > process.stdout.rows - 1) {
          resultList.splice(1, 1);
        }
        writeListToTerminal(resultList);
        bar.increment();
      }
    }

    // Wait for all fetch
    while (this.onFetch[0]) {
      await sleep(500);
    }
    bar.stop();

    writeFileSync(`${initiator.path}/result/${initiator.domain}/sni.json`, JSON.stringify(result, null, 2));
  }
}

const scanner = new Scanner();

export { scanner };
