global.env = process.env.NODE_ENV || "development"
global.debugMode = env === "development" ? true : false

global.PLAYER_CAPACITY_PER_SECTOR = 5
global.MAX_SECTORS_PER_SERVER = 8
global.SERVER_COUNT_PER_NODE = env === "staging" ? 2 : 4
global.SCALE_UP_REQUIRED_USAGE_THRESHOLD = 0.8
global.SCALE_DOWN_USAGE_THRESHOLD = 0.5
global.SCALE_UP_INTERVAL = 15 * 60 * 1000 // 15 minutes

const cors = require("cors")
const uws = require("uWebSockets.js")
const ExceptionReporter = require("archerfall-common/exception_reporter")
const SocketUtil = require("archerfall-common/socket_util")
const LOG = require("archerfall-common/logger")
const queryString = require("querystring")
const util = require("util")
const User = require("archerfall-common/db/user")
const Level = require("archerfall-common/db/level")
const Ranking = require("archerfall-common/db/ranking")
const Config = require("./config")
const Sequelize = require("sequelize")
const Op = Sequelize.Op

let textDecoder = new util.TextDecoder()

const FirebaseAdminHelper = require("./firebase_admin_helper")
const Environment = require("./environment")
const BadWordsFilter = require("./bad_words_filter")
const AWS = require("aws-sdk")
const spacesEndpoint = new AWS.Endpoint("nyc3.digitaloceanspaces.com")
s3 = new AWS.S3({
    endpoint: spacesEndpoint,
})

global.getSocketRemoteAddress = (socket) => {
    let uint8Array = new Uint8Array(socket.getRemoteAddress())
    return [uint8Array[12], uint8Array[13], uint8Array[14], uint8Array[15]].join(".")
}

class MatchmakerServer {
    constructor() {
        this.bootTime = Date.now()
        this.APP_SERVER_PORT = debugMode ? 3000 : 80
        this.GAME_WEBSOCKET_SERVER_PORT = 2095

        this.ENVIRONMENT_LIST = ["vm", "development", "staging", "production"]

        ExceptionReporter.init({
            dsn: Config.SENTRY_DSN,
        })

        FirebaseAdminHelper.init()

        SocketUtil.init({ isTextMode: true })

        this.init()
    }

    init() {
        this.onlinePlayersByIp = {}
        this.onlinePlayersByHost = {}
        this.environments = {}
        this.gameServerSockets = {}
        this.latencyProfiles = {}

        this.environments[env] = new Environment(this, env)
    }

    async run() {
        let app = this.buildUwsApp()

        this.initServerForPlayers()
        this.initWebsocketServerForGames()
    }

    getSocketUtil() {
        return SocketUtil
    }

    async getUidFromRequest(idToken, uid) {
        if (debugMode) return uid
        return await FirebaseAdminHelper.verifyIdToken(idToken)
    }

    forEachEnvironment(cb) {
        for (let environmentName in this.environments) {
            cb(this.environments[environmentName])
        }
    }

    onPlayerDisconnect(socket) {
        try {
            this.forEachEnvironment((environment) => {
                environment.forEachRegion((region) => {
                    region.removeSocket(socket)
                })
            })
        } catch (e) {
            ExceptionReporter.captureException(e)
        }
    }

    buildUwsApp() {
        let app

        app = uws.App()

        return app
    }

    decodeArrayBufferAsString(arrayBuffer) {
        let result = ""

        try {
            result = String.fromCharCode.apply(null, new Uint8Array(arrayBuffer))
        } catch (e) {
            ExceptionReporter.captureException(e)
        }

        return result
    }

    initServerForPlayers() {
        let app = this.buildUwsApp()

        app.get("/servers", (res, req) => {
            res.writeHeader("Access-Control-Allow-Origin", "*")
            res.writeHeader("Content-Type", "text/plain")
            this.onListServers(res, req)
        })

        app.get("/server_status", (res, req) => {
            res.writeHeader("Access-Control-Allow-Origin", "*")
            res.writeHeader("Content-Type", "text/plain")
            this.onServerStatus(res, req)
        })

        app.get("/ping", (res, req) => {
            res.writeHeader("Access-Control-Allow-Origin", "*")
            res.writeHeader("Content-Type", "text/plain")
            res.end("pong")
        })

        app.get("/find_server", (res, req) => {
            res.writeHeader("Access-Control-Allow-Origin", "*")
            res.writeHeader("Content-Type", "text/plain")

            this.onFindServer(res, req)
        })

        app.get("/game_list", (res, req) => {
            res.writeHeader("Access-Control-Allow-Origin", "*")
            res.writeHeader("Content-Type", "text/plain")

            this.onGameList(res, req)
        })

        app.get("/checkname", (res, req) => {
            res.writeHeader("Access-Control-Allow-Origin", "*")
            res.writeHeader("Content-Type", "text/plain")

            try {
                let query = queryString.decode(req.getQuery())

                if (BadWordsFilter.isBadWord(query.username)) {
                    res.end("invalid")
                } else {
                    res.end("valid")
                }
            } catch (e) {
                ExceptionReporter.captureException(e)
                res.end("invalid")
            }
        })

        app.options("/create_user", (res, req) => {
            res.writeHeader("Access-Control-Allow-Origin", "*")
            res.writeHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS, DELETE")
            res.writeHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept")
            res.end()
        })

        app.get("/get_user", async (res, req) => {
            res.writeHeader("Access-Control-Allow-Origin", "*")
            res.writeHeader("Content-Type", "text/plain")

            res.onAborted(() => {
                console.log("User find aborted")
            })

            try {
                let query = queryString.decode(req.getQuery())
                let uid = query.uid

                let user = await User.findOne({
                    where: { uid: uid },
                })

                if (!user) {
                    let data = { error: "User not found" }
                    return res.end(JSON.stringify(data))
                }

                let userData = user.getPublicData()
                res.end(JSON.stringify(userData))
            } catch (e) {
                ExceptionReporter.captureException(e)
                res.end(JSON.stringify({ error: "invalid" }))
            }
        })

        app.get("/rankings", async (res, req) => {
            res.writeHeader("Access-Control-Allow-Origin", "*")
            res.writeHeader("Content-Type", "text/plain")

            this.onListRankings(res, req)
        })

        app.get("/me", async (res, req) => {
            res.writeHeader("Access-Control-Allow-Origin", "*")
            res.writeHeader("Content-Type", "text/plain")

            res.onAborted(() => {
                console.log("User find aborted")
            })

            try {
                let query = queryString.decode(req.getQuery())
                let uid = await this.getUidFromRequest(query.idToken, query.uid)
                if (!uid) {
                    let data = { error: "Invalid credentails." }
                    res.end(JSON.stringify(data))
                    return
                }

                let user = await User.findOne({
                    where: { uid: uid },
                    include: [{ model: Ranking, as: "rankings" }],
                })

                if (!user) {
                    let data = { error: "User not found" }
                    return res.end(JSON.stringify(data))
                }

                let userData = user.toJSON()
                res.end(JSON.stringify(userData))
            } catch (e) {
                ExceptionReporter.captureException(e)
                res.end(JSON.stringify({ error: "invalid" }))
            }
        })

        app.post("/create_user", async (res, req) => {
            res.writeHeader("Access-Control-Allow-Origin", "*")

            this.readJson(res).then(async (body) => {
                try {
                    if (!body.idToken) {
                        let data = { error: "Missing idToken. Make sure you are properly logged in." }
                        res.end(JSON.stringify(data))
                        return
                    }

                    let uid = await this.getUidFromRequest(body.idToken, body.uid)
                    if (!uid) {
                        let data = { error: "Invalid credentails." }
                        res.end(JSON.stringify(data))
                        return
                    }

                    let email = body.email
                    let username = body.username

                    if (this.isBadWord(username)) {
                        let data = { error: "Name not appropriate." }
                        res.end(JSON.stringify(data))
                        return
                    }

                    if (username.match(/[^a-zA-Z0-9_]/)) {
                        let data = { error: "username can only contain alphanumeric characters and _" }
                        res.end(JSON.stringify(data))
                        return
                      }

                    if (username.length > 16) {
                        let data = { error: "username cannot be more than 16 characters" }
                        res.end(JSON.stringify(data))
                        return
                    }

                    let user = await User.createOne({ uid: uid, name: username, email: email })
                    if (user.error) {
                        return res.end(JSON.stringify({ error: user.error }))
                    }

                    let data = { success: true }
                    res.end(JSON.stringify(data))
                } catch (e) {
                    ExceptionReporter.captureException(e)
                    let data = { error: "Unable to create user" }
                    res.end(JSON.stringify(data))
                }
            })
        })

        app.get("/featured_levels", (res, req) => {
            res.writeHeader("Access-Control-Allow-Origin", "*")
            res.writeHeader("Content-Type", "text/plain")
            this.onListFeaturedLevels(res, req)
        })

        app.get("/my_levels", (res, req) => {
            res.writeHeader("Access-Control-Allow-Origin", "*")
            res.writeHeader("Content-Type", "text/plain")
            this.onListMyLevels(res, req)
        })

        app.options("/create_level", (res, req) => {
            res.writeHeader("Access-Control-Allow-Origin", "*")
            res.writeHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS, DELETE")
            res.writeHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept")
            res.end()
        })

        app.post("/create_level", async (res, req) => {
            res.writeHeader("Access-Control-Allow-Origin", "*")

            this.readJson(res).then(async (body) => {
                try {
                    let levelName = "New Map"

                    if (!body.idToken) {
                        let data = { error: "Missing idToken. Make sure you are properly logged in." }
                        res.end(JSON.stringify(data))
                        return
                    }

                    let uid = await this.getUidFromRequest(body.idToken, body.uid)
                    if (!uid) {
                        let data = { error: "Invalid credentails." }
                        res.end(JSON.stringify(data))
                        return
                    }

                    let level = await Level.createOne({
                        creatorUid: uid,
                        name: levelName,
                        isPrivate: body.isPrivate,
                        thumbnail: "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==",
                        data: "{}",
                    })
                    if (level.error) {
                        return res.end(JSON.stringify({ error: level.error }))
                    }

                    let data = { success: true }
                    res.end(JSON.stringify(data))
                } catch (e) {
                    ExceptionReporter.captureException(e)
                    let data = { error: "Unable to create level" }
                    res.end(JSON.stringify(data))
                }
            })
        })

        app.options("/delete_level", (res, req) => {
            res.writeHeader("Access-Control-Allow-Origin", "*")
            res.writeHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS, DELETE")
            res.writeHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept")
            res.end()
        })

        app.post("/delete_level", async (res, req) => {
            res.writeHeader("Access-Control-Allow-Origin", "*")

            this.readJson(res).then(async (body) => {
                try {
                    if (!body.idToken) {
                        let data = { error: "Missing idToken. Make sure you are properly logged in." }
                        res.end(JSON.stringify(data))
                        return
                    }

                    let uid = await this.getUidFromRequest(body.idToken, body.uid)
                    if (!uid) {
                        let data = { error: "Invalid credentails." }
                        res.end(JSON.stringify(data))
                        return
                    }

                    let levelUid = body.levelUid
                    if (!levelUid) {
                        let data = { error: "Invalid level." }
                        res.end(JSON.stringify(data))
                        return
                    }

                    let level = await Level.findOne({
                        where: { uid: levelUid, creatorUid: uid },
                    })

                    if (!level) {
                        let data = { error: "Level not found." }
                        res.end(JSON.stringify(data))
                        return
                    }

                    await level.destroy()

                    let data = { success: true }
                    res.end(JSON.stringify(data))
                } catch (e) {
                    ExceptionReporter.captureException(e)
                    let data = { error: "Unable to delete level" }
                    res.end(JSON.stringify(data))
                }
            })
        })

        app.ws("/*", {
            maxPayloadLength: 16 * 1024 * 1024,
            idleTimeout: 120,
            open: (ws, req) => {
                let forwardedIp = req.getHeader("x-forwarded-for")

                if (forwardedIp.length > 0) {
                    ws.remoteAddress = forwardedIp
                } else {
                    ws.remoteAddress = getSocketRemoteAddress(ws)
                }

                SocketUtil.registerSocket(ws)
            },
            message: (ws, message, isBinary) => {
                let textMessage = this.decodeArrayBufferAsString(message)
                this.handlePlayerMessage(ws, textMessage)
            },
            close: (ws, code, message) => {
                ws.isClosed = true
                SocketUtil.unregisterSocket(ws)
                this.onPlayerDisconnect(ws)
            },
        })

        this.bindPort(app, "Matchmaker", this.APP_SERVER_PORT)
    }

    bindPort(app, name, port) {
        app.listen(port, (token) => {
            if (token) {
                console.log("server for " + name + " listening to port " + port)
            } else {
                console.log("server for " + name + " failed to listen to port " + port)
            }
        })
    }

    initWebsocketServerForGames() {
        let app = this.buildUwsApp()

        app.ws("/*", {
            maxPayloadLength: 16 * 1024 * 1024,
            idleTimeout: 120,
            open: (ws, req) => {
                SocketUtil.registerSocket(ws)
            },
            message: (ws, message, isBinary) => {
                let textMessage = textDecoder.decode(message)
                this.handleGameServerMessage(ws, textMessage)
            },
            close: (ws, code, message) => {
                ws.isClosed = true
                SocketUtil.unregisterSocket(ws)
                this.onGameServerDisconnect(ws)
            },
        })

        this.bindPort(app, "Game", this.GAME_WEBSOCKET_SERVER_PORT)
    }

    handlePlayerMessage(socket, message) {
        try {
            let json = JSON.parse(message)
            let data = json.data
            switch (json.event) {
                // ping
                case "1":
                    this.onPing(data, socket)
                    break
                case "RequestGame":
                    this.onRequestGame(data, socket)
                    break
            }
        } catch (e) {
            ExceptionReporter.captureException(e)
        }
    }

    handleGameServerMessage(socket, message) {
        try {
            let json = JSON.parse(message)
            let data = json.data
            switch (json.event) {
                case "ServerUpdated":
                    this.onServerUpdated(data, socket)
                    break
                case "Heartbeat":
                    this.onHeartbeat(data, socket)
                    break
            }
        } catch (e) {
            ExceptionReporter.captureException(e)
        }
    }

    formatLatencyProfile(latencyProfile) {
        let matchmakerRequest = (latencyProfile.matchmakerRequestGame - latencyProfile.start) / 1000
        let gameServerCreate = (latencyProfile.gameCreated - latencyProfile.matchmakerRequestGame) / 1000

        return [`matchmakerRequest took ${matchmakerRequest}s`, `gameServerCreate took ${gameServerCreate}s`].join("\n")
    }

    getEnvironment() {
        return this.environments[global.env]
    }

    getRegion(data) {
        let environment = this.getEnvironment()
        if (!environment) return null

        return environment.getRegion(data.region)
    }

    getNode(data) {
        let region
    }

    getServer(data) {
        let region = this.getRegion(data)
        if (!region) return null

        return region.getServer(data.host)
    }

    onPlayerCountChanged(sector) {}

    onHeartbeat(data, socket) {
        this.onServerUpdated(data, socket, true)
    }

    onServerUpdated(data, socket, isHeartbeat = false) {
        if (!socket.region) {
            socket.region = data.region
            socket.host = data.host
        }

        this.gameServerSockets[data.host] = socket

        let region = this.getRegion(data)
        if (!region) return

        let server = region.getServer(data.host)
        if (!server) {
            server = region.createServer(data)
            LOG.info("server " + socket.host + " added. isHeartbeat: " + isHeartbeat)
        }

        data.socket = socket
        server.update(data)
    }

    onGameServerDisconnect(socket) {
        try {
            delete this.gameServerSockets[socket.host]

            let region = this.getRegion({ region: socket.region })
            if (region && socket.host) {
                LOG.info("server " + socket.host + " disconnected. removing from registry")

                region.removeServerByHost(socket.host)
            }
        } catch (e) {
            ExceptionReporter.captureException(e)
        }
    }

    onPing(data, socket) {
        SocketUtil.emit(socket, "1", {})
    }

    onRequestGame(data, socket) {
        this.handleGameRequest(data, socket)
    }

    handleGameRequest(data, socket) {
        let region = this.getRegion({ region: data.region })
        if (!region) {
            SocketUtil.emit(socket, "RequestGameStatus", { error: "invalid region" })
            return
        }

        let server = region.getAvailableServer({ mode: data.mode })
        if (!server) {
            SocketUtil.emit(socket, "RequestGameStatus", { error: "servers full" })
            return
        }

        SocketUtil.emit(socket, "RequestGameStatus", {
            server: server.getHost(),
            mode: data.mode,
        })
    }

    getTotalOnlineCount() {
        let total = 0

        let environment = this.getEnvironment()
        for (let regionName in environment.regions) {
            let region = environment.regions[regionName]
            total += region.getPlayerCount()
        }

        return total
    }

    getOnlineCountByRegion() {
        let result = {}

        let environment = this.getEnvironment()
        for (let regionName in environment.regions) {
            let region = environment.regions[regionName]
            result[regionName] = region.getPlayerCount()
        }

        return result
    }

    async onListFeaturedLevels(res, req) {
        try {
            res.onAborted(() => {
                console.log("list level aborted")
            })

            let levels = await Level.findAll({
                where: {
                    isFeatured: {
                        [Op.eq]: true,
                    },
                    isPrivate: {
                        [Op.eq]: false,
                    },
                },
                limit: 50,
            })

            let result = levels.map((level) => {
                let json = level.getPublicData()
                delete json["data"]
                return json
            })

            res.end(JSON.stringify(result))
        } catch (e) {
            ExceptionReporter.captureException(e)
            res.end(JSON.stringify({ error: "Unable to list levels" }))
        }
    }

    async onListRankings(res, req) {
        try {
            res.onAborted(() => {
                console.log("list ranking aborted")
            })

            let rankings = await Ranking.findAll({
                include: [{ model: User, as: "user" }],
                limit: 100,
                order: [["winCount", "DESC"]],
            })

            let result = rankings.map((ranking) => {
                let json = ranking.toJSON()
                delete json["createdAt"]
                delete json["updatedAt"]
                json["name"] = json["user"]["name"]
                delete json["user"]
                return json
            })

            res.end(JSON.stringify(result))
        } catch (e) {
            ExceptionReporter.captureException(e)
            res.end(JSON.stringify({ error: "Unable to list rankings" }))
        }
    }

    async onListMyLevels(res, req) {
        try {
            res.onAborted(() => {
                console.log("list level aborted")
            })

            let query = queryString.decode(req.getQuery())
            let uid = await this.getUidFromRequest(query.idToken, query.uid)
            if (!uid) {
                let data = { error: "Invalid credentails." }
                res.end(JSON.stringify(data))
                return
            }

            let user = await User.findOne({
                where: { uid: uid },
                include: [{ model: Level, as: "saves" }],
            })
            if (!user) {
                let data = { error: "User not found" }
                return res.end(JSON.stringify(data))
            }

            let result = user.saves.map((level) => {
                let json = level.getPublicData()
                delete json["data"]
                return json
            })
            res.end(JSON.stringify(result))
        } catch (e) {
            ExceptionReporter.captureException(e)
            res.end(JSON.stringify({ error: "Unable to list levels" }))
        }
    }

    onFindServer(res, req) {
        let query = queryString.decode(req.getQuery())
        let gameUid = query.uid

        let environment = this.getEnvironment()
        let result = null

        environment.forEachRegion((region) => {
            region.forEachServer((server) => {
                if (server.hasGame(gameUid)) {
                    result = server.host
                }
            })
        })

        res.end(JSON.stringify({ server: result }))
    }

    onListServers(res, req) {
        try {
            let query = queryString.decode(req.getQuery())
            let environment = this.getEnvironment()
            let serversByRegion = environment.getOneServerByRegion()
            let totalOnlineCount = this.getTotalOnlineCount()
            let onlineCountByRegion = this.getOnlineCountByRegion()

            res.end(
                JSON.stringify({
                    totalOnlineCount: totalOnlineCount,
                    serversByRegion: serversByRegion,
                    onlineCountByRegion: onlineCountByRegion,
                })
            )
        } catch (e) {
            ExceptionReporter.captureException(e)
            res.end(JSON.stringify({ error: "Unable to list servers" }))
        }
    }

    onGameList(res, req) {
        try {
            let result = {}

            let environment = this.getEnvironment()
            environment.forEachRegion((region) => {
                region.forEachServer((server) => {
                    result = Object.assign({}, result, server.getPublicGames())
                })
            })

            res.end(JSON.stringify(result))
        } catch (e) {
            ExceptionReporter.captureException(e)
            res.end(JSON.stringify({ error: "Unable to list games" }))
        }
    }

    async onServerStatus(res, req) {
        try {
            let result = {}

            let environment = this.getEnvironment()
            environment.forEachRegion((region) => {
                result[region.name] = result[region.name] || {}
                region.forEachServer((server) => {
                    let hostName = server.host
                    result[region.name][hostName] = server.getStatusData()
                })
            })

            res.end(JSON.stringify(result))
        } catch (e) {
            ExceptionReporter.captureException(e)
            res.end(JSON.stringify({ error: "Unable to check server status" }))
        }
    }

    isBadWord(text) {
        return BadWordsFilter.isBadWord(text)
    }

    readJson(res) {
        return new Promise((resolve, reject) => {
            let buffer

            res.onData((ab, isLast) => {
                let chunk = Buffer.from(ab)
                if (isLast) {
                    let json
                    if (buffer) {
                        try {
                            json = JSON.parse(Buffer.concat([buffer, chunk]))
                        } catch (e) {
                            /* res.close calls onAborted */
                            ExceptionReporter.captureException(e)
                            res.close()
                            return
                        }
                        resolve(json)
                    } else if (chunk.length > 0) {
                        try {
                            json = JSON.parse(chunk)
                        } catch (e) {
                            /* res.close calls onAborted */
                            ExceptionReporter.captureException(e)
                            res.close()
                            return
                        }
                        resolve(json)
                    }
                } else {
                    if (buffer) {
                        buffer = Buffer.concat([buffer, chunk])
                    } else {
                        buffer = Buffer.concat([chunk])
                    }
                }
            })

            res.onAborted(() => {
                /* Request was prematurely aborted or invalid or missing, stop reading */
                console.log("Invalid JSON or no data at all!")
            })
        })
    }
}

if (debugMode) {
    require("dns").lookup("www.google.com", (err) => {
        if (err) {
            global.isOffline = true
        }

        global.server = new MatchmakerServer()
        global.server.run()
    })
} else {
    global.server = new MatchmakerServer()
    global.server.run()
}
