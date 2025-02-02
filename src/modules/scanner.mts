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
