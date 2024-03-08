const { launch, getStream } = require("puppeteer-stream")
const ffmpeg = require("fluent-ffmpeg")
const fs = require("fs")
const yargs = require("yargs")
const open = require("opener");
const progress = require("cli-progress")

async function waitUntilVictory(timeout, page, endTurn) {
    let ret = new Promise(async (resolve, reject) => {
        setTimeout(() => {
            if (!ret.isResolved) {
                reject()
            }
        }, timeout)

        await checkForVictory(page, endTurn)
        resolve()
    })
    return ret
}

async function checkForVictory(page, endTurn, state = {turn: 0, part: 0, logSize: 0, msg: null}) {
    try {
        const [victory, msg, turn] = await Promise.all([
            page.$$eval('div[class="battle-history"]', els => els.map(e => e.textContent)),
            page.$$eval('*[class="messagebar message"]', els => els.map(e => e.textContent)),
            page.$$eval('.turn', els => els.pop().textContent)
                .then(it => it.split(' ')[1])
                .then(parseInt),
        ])

        if (turn > state.turn) {
            if (debug) console.log(turn)
            state.turn = turn
            state.part = 0
            if (turn >= endTurn) return
        }

        // noinspection EqualityComparisonWithCoercionJS
        if (String(msg) != String(state.msg)) {
            // split the turn into sections based on message log state
            state.msg = msg
            const turnPart = parseFloat(turn + '.' + ++state.part)
            if (debug) console.log(turnPart)
            if (turnPart === endTurn) return
        }

        if (victory.length > state.logSize) {
            if (debug) {
                if (!state.logSize) state.logSize = victory.length - 1
                while (victory.length > state.logSize) console.log(victory[state.logSize++]);
            } else state.logSize = victory.length
            if (victory[state.logSize - 1].endsWith(" won the battle!")) {
                // Wait for 2 seconds so that the battle has completely ended as we read the text earlier than it getting fully animated
                await new Promise((resolve) => setTimeout(resolve, 1500))
                return
            }
        }

        //await new Promise((resolve) => setTimeout(resolve, 1))
        await checkForVictory(page, endTurn, state)
    } catch {}
}

// Create a FFmpeg command to fix the metadata
async function fixwebm(file, tmpFile) {
    return new Promise((resolve, reject) => {
        const command = ffmpeg(tmpFile)
            .withVideoCodec("copy")
            .withAudioCodec("copy") // Copy the video and audio streams without re-encoding
            .output(file)
            .on("end", () => {
                resolve()
            })
            .on("error", (err) => {
                console.error("Error fixing metadata:", err)
                reject(err)
            })

        command.run()
    })
}

async function makeGif(file) {
    const bar = new progress.SingleBar()
    console.log('starting Gif creation')
    const [filename,] = file.split('.', 1)
    const palette = filename + '.png'
    const gif = filename + '.gif'
    const withBar = (resolve, reject, s) => s
        .on('start', () => bar.start(100, 0))
        .on('progress', ({percent}) => {
            bar.update(percent)
            bar.render()
        })
        .on('end', () => {
            bar.update(100)
            bar.stop()
            resolve()
        })
        .on('error', reject)

    const resized = filename + '.resize.webm'
    return new Promise((resolve, reject) => withBar(resolve, reject,
        ffmpeg(file)
            .inputOptions('-y')
            .videoFilter([
                "crop=1200:890:200:5",
                "scale=600:-1",
            ])
            .save(resized)
        )
    ).then(() => new Promise((resolve, reject) =>
        withBar(resolve, reject, ffmpeg(resized))
            .videoFilter('palettegen')
            .save(palette)
    )).then(() => new Promise((resolve, reject) => withBar(resolve, reject, ffmpeg())
            .addInput(resized)
            .addInput(palette)
            .addInputOption("-filter_complex paletteuse")
            .addInputOption("-r 10")
            .outputFPS(20) // todo automatically determine fps by duration
            .save(gif)
        )
    )
        .catch(console.error)
        .finally(() => fs.rmSync(palette))
        .catch(() => {}) // do nothing

}

async function download(link, browser, {nochat, nomusic, noaudio, noteams, theme, speed, gif}) {
    let turns
    if (typeof link === 'object') {
        turns = link.turns
        link = link.link
    }
    const query = link.split('?', 2)
    let params = query.length === 1 ? Array() : Array.of(...(query.length > 1 && query[1].split('&')))
    link = query[0]
    if (
        !(
            link.startsWith("https://replay.pokemonshowdown.com/") ||
            link.startsWith("http://replay.pokemonshowdown.com/")
        ) &&
        !(link.endsWith(".json") || link.endsWith(".log"))
    )
        return console.log(`Invalid link: ${link}`)

    const response = await fetch(link + ".json")
    if (!response.ok) {
        console.log(
            `Unable to join the url. Please ensure ${link} is a valid showdown replay.`
        )
        return
    }
    const data = await response.json()
    const matches = Array.from(data.log.matchAll(/\n\|turn\|(\d+)\n/g))
    const startTurn = (turns && turns.start) || 0
    if (startTurn > 0) params = Array.of(...params, 'turn=' + startTurn)
    let endTurn = parseInt(matches[matches.length - 1][1]);
    let playToVictory = true;
    if (turns && turns.end) {
        if (turns.end > endTurn) {
            console.log(`Invalid end turn ${turns.end} (total turns=${endTurn})`);
            return;
        } else if (endTurn !== turns.end) {
            playToVictory = false
            endTurn = turns.end;
        }
    }
    const totalTurns = endTurn - Math.max(startTurn - 1, 0)
    if (playToVictory) endTurn++; // disable check
    const filename = `replays/replay-${generateRandom()}.webm`
    const tmpFile = filename + ".tmp"
    try {
        const file = fs.createWriteStream(tmpFile)
        const page = await browser.newPage()
        await page.setViewport({ width: 1920, height: 1080 }) // 1920 x 1080 screen resolution
        if (params) {
            link += '?' + params.join('&')
        }
        await page.goto(link, { waitUntil: "load", })
        await page.addStyleTag({
            content: `
                header {
                    display: none !important;
                }
                .bar-wrapper {
                    margin: 0 0 !important;
                }
                
                ${noteams ? ".leftbar, .rightbar { display: none; }" : ""}
                
                .battle {
                    top: 0px !important;
                    left: 0px !important;
                    ${nochat ? "margin: 0 !important;" : ""}
                }
                .battle-log {
                    top: 0px !important;
                    left: 641px !important;
                    ${nochat ? "display: none !important;" : ""}
                }
                `,
        })
        //await page.waitForSelector(".playbutton") // playbutton doesn't appear if we use ?turn query
        // Customization
        // Default: music: yes, audio: yes, video: yes (why would anyone want to not record video..), speed: normal, color scheme: automatic, recordChat: yes
        // Example for if you want your replay speed to be changed dynamically per individual video on total turns basis:-
        // if (totalTurns > 20) speed = "fast"
        if (speed !== "normal") await page.select('select[name="speed"]', speed)

        if (nomusic) await page.select('select[name="sound"]', "musicoff")
        else if (noaudio) await page.select('select[name="sound"]', "off")
        // Theme
        if (theme !== "auto")
            await page.select('select[name="darkmode"]', theme)

        // customization done, now remove scrollbar by making below elements invisible
        await page.addStyleTag({
            content: `
                .replay-controls { display: none !important; }
                #LeaderboardBTF { display: none !important; }`,
        })
        const stream = await getStream(page, {
            audio: !noaudio, // no longer a necessity, can be left as true
            video: true,
        })
        await page.keyboard.type('k')
        stream.pipe(file)

        console.log(
            `Opened replay ${data.players[0]} vs ${data.players[1]} (${
                data.format
            } turns ${startTurn}-${endTurn})\nSaving Replay..  (this may take a while.. preferably not more than ${(
                (totalTurns * 7) /
                60
            ).toFixed(2)} minutes)\n[*estimates are calced at normal speed*]`
        ) // the estimate is based upon my observation for "normal" speed replays

        // Start checking for victory, upto 5 minutes (aka record time limit)
        // You might want to modify this for super long videos as with endless battle clause, a battle can last upto 1000 turns which is approx 1 hour and 56 minutes at normal speed
        try {
            await waitUntilVictory(150000, page, endTurn)
        } catch {}

        stream.destroy()
        file.close()

        console.log(`Finished recording ${link}`)
        try {
            page.close()
        } catch (error) {
            console.error(error)
        }

        await fixwebm(filename, tmpFile) // metadata needs to be added for seeking video
        console.log("Recording Saved!\nLocation -> " + filename)
        if (debug) open('./' + filename)
        if (gif) {
            await makeGif(filename)
            if (debug) open('./' + filename.split('.')[0] + ".gif")
        }

    } catch (err) {
        console.log(`An error occured while downloading ${link}\n` + err)
    } finally {
        try { fs.unlinkSync(tmpFile) } catch {}
    }
}

const generateRandom = () =>
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(23).substring(2, 5) // simplistic simple https://stackoverflow.com/a/71262982/14393614

const argv = yargs(process.argv.slice(2))
    .usage('Usage: $0 -l "[replays]"')
    .demandOption(["links"])
    .option("links", {
        alias: "l",
        describe: "List of ps replay links separated by a comma or space",
        type: "string",
        demandOption: true,
    })
    .option("nomusic", {
        describe: "Disable music (battle cries don't get muted)",
        type: "boolean",
        default: false,
    })
    .option("noaudio", {
        describe: "Disable audio (disables music too obviously)",
        type: "boolean",
        default: false,
    })
    .option("speed", {
        alias: "s",
        describe: "Speed (really fast, fast, normal, slow, really slow)",
        choices: ["normal", "fast", "slow", "really slow", "really fast"],
        default: "normal",
    })
    .option("nochat", {
        describe: "Will not record chat",
        type: "boolean",
        default: false,
    })
    .option("noteams", {
        describe: "Will not show teams",
        type: "boolean",
        default: false,
    })
    .option("theme", {
        alias: "t",
        describe: "Color Scheme",
        choices: ["auto", "dark", "light"],
        default: "auto",
    })
    .option("bulk", {
        alias: "b",
        describe: 'Bulk record option (a number >= 1 or "all")',
        type: "string",
        default: "all",
    })
    .option("debug", {
        alias: 'd',
        describe: 'enable debug functionality - automatically open image and print battle log to console',
        type: 'boolean',
        default: 'false'
    })
    .option("gif", {
        type: "boolean",
        default: false,
    })
    .help("h")
    .alias("h", "help").argv

let debug

;(async () => {
    let links = argv.links.split(/[\s,]+/).filter(Boolean) // https://stackoverflow.com/a/23728809/14393614
    debug = argv.debug
    let bulk = argv.bulk

    for (let i = links.length - 1; i > 0; i--) {
        let match = links[i].match(/(\d+)?-((?:[0-9]*[.])?[0-9]+)?/);
        if (match) {
            links.splice(i, 1) // remove at this index
            links[i - 1] = {
                link: links[i - 1],
                turns: {start: match[1] && parseInt(match[1]), end: match[2] && parseFloat(match[2])}
            };
            i--;
        }
    }

    if (parseInt(bulk) && bulk >= 1) {
        bulk = parseInt(bulk)
        if (bulk > links.length) {
            bulk = links.length
        }
    } else if (bulk !== "all") {
        console.log(
            `Invalid value: Argument bulk, Given: "${bulk}", Takes: all/a number 1 or above.`
        )
        process.exit()
    }
    console.log("--Booting Downloader--")
    try {
        fs.mkdirSync("./replays")
    } catch {}
    const toRecord = []
    if (links.length > 1) {
        if (bulk === "all" || bulk > 1) {
            console.log(
                `Bulk recording is enabled, thus ${bulk} videos will be recorded simultaneously. (This may cause poorer recorded quality)\n(Optional) Set bulk to 1 (via -b 1) to record only one video at a time for optimum quality.\n[node download.js -h to view syntax, all arguments]`
            )
            if (bulk === "all") toRecord.push(links)
            else {
                // chunk the links into smaller lists of size -> bulk
                for (let i = 0; i < links.length; i += bulk) {
                    toRecord.push()
                }
            }
        } else
            console.log(
                "Bulk recording is disabled (set to 1). Thus replays will be downloaded one at a time."
            )
    }

    let width = 1175
    if (argv.nochat) width -= 517
    const height = 546 // 340 original (added +200 due to two chrome's popups 100h each of (a) -> download non-test version chrome and (b) -> Chrome is being controlled by automated test software)
    const args = [`--window-size=${width},${height}`, `--headless=new`]

    const browser = await launch({
        executablePath: require("puppeteer").executablePath(),
        defaultViewport: null,
        args: args,
    })
    if (links.length > 1 && (bulk === "all" || bulk > 1)) {
        let bulkRecord = []
        for (let recordLinks of toRecord) {
            for (let link of recordLinks) bulkRecord.push(download(link, browser, argv))

            await Promise.all(bulkRecord) // wait on all recordings to occur simultaneously
            bulkRecord = [] // reset array
        }
    } else {
        for (let link of links) await download(link, browser, argv) // record one by one
    }
    console.log("Thank you for utilising Showdown Replay Downloader!!")
    try {
        await browser.close()
    } catch {}
    try {
        process.exit()
    } catch {}
})()
