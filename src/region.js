const Server = require('./server')
const ExceptionReporter = require("archerfall-common/exception_reporter")
const SocketUtil = require("archerfall-common/socket_util")
const LOG = require('archerfall-common/logger')

class Region {
  constructor(environment, name) {
    this.environment = environment
    this.matchmaker = environment.matchmaker
    this.name = name

    this.servers = {}

    this.playerSessions = {}
    this.disconnectedServers = {}

    this.sockets = {}

    this.chatHistory = []

  }

  isPvPEnabled() {
    return this.name !== 'sgp1' && this.name !== 'fra1'
  }

  hasExistingPlayerSession(uid) {
    return this.playerSessions[uid]
  }

  addPlayerSession(uid) {
    this.playerSessions[uid] = uid
  }

  removePlayerSession(uid) {
    delete this.playerSessions[uid]
  }

  getServerByHost(host) {
    return this.servers[host]
  }

  getServer(host) {
    return this.servers[host]
  }

  getName() {
    return this.name
  }

  addSocket(socket) {
    this.sockets[socket.id] = socket
  }

  removeSocket(socket) {
    delete this.sockets[socket.id]
  }

  getSocketIds() {
    return Object.keys(this.sockets)
  }

  getOneServerJson() {
    let data = {}
    const serverHostList = Object.keys(this.servers)
    if (serverHostList.length === 0) return data

    data[serverHostList[0]] = true
    return data
  }

  getServersJson() {
    let servers = {}

    for (let host in this.servers) {
      let server = this.servers[host]
      servers[server.host] = { playerCount: server.getPlayerCount() }
    }

    return servers
  }

  addDisconnectedServer(server) {
    try {
      this.disconnectedServers[server.host] = {
        server: server,
        disconnectedAt: Date.now()
      }
    } catch(e) {
      ExceptionReporter.captureException(e)
    }
  }

  createServer(data) {
    let server = new Server(this, data)
    this.addServer(server)

    return server
  }

  addServer(server) {
    this.servers[server.getHost()] = server
  }

  removeServer(server) {
    delete this.servers[server.getHost()]
  }

  removeServerByHost(host) {
    delete this.servers[host]
  }

  removeDisconnectedServer(server) {
    try {
      delete this.disconnectedServers[server.host]
    } catch(e) {
      ExceptionReporter.captureException(e)
    }
  }

  onGlobalClientChat(data) {
    let chatMessage = { username: data.username, message: data.message, uid: data.uid }
    this.chatHistory.push(chatMessage)

    if (this.chatHistory.length > 100) {
      this.chatHistory.shift()
    }

    this.broadcastMessage(chatMessage)
  }

  sendChatHistory(socket) {
    SocketUtil.emit(socket, "ChatHistory", this.chatHistory)
  }

  broadcastMessage(chatMessage) {
    for (let socketId in this.sockets) {
      let socket = this.sockets[socketId]

      SocketUtil.emit(socket, "ServerChat", chatMessage)
    }
  }

  getPlayerCount() {
    let result = 0

    this.forEachServer((server) => {
      result += server.getPlayerCount()
    })

    return result
  }

  onPlayerCountChanged() {
    this.matchmaker.onPlayerCountChanged()
  }

  forEachServer(cb) {
    for (let host in this.servers) {
      let server = this.servers[host]
      cb(server)
    }
  }

  getAvailableServer() {
    let result

    for (let host in this.servers) {
      let server = this.servers[host]
      if (!server.isTemporaryUnavailable) {
        result = server
        break
      }
    }

    return result
  }


}

module.exports = Region
