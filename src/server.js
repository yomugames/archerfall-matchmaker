const SocketUtil = require("archerfall-common/socket_util")
const LOG = require('archerfall-common/logger')
const uuidv4 = require('uuid/v4')

class Server {
  constructor(region, data) {
    this.region = region
    this.matchmaker = region.matchmaker
    this.host = data.host
    this.revision = data.revision
    this.data = data

    this.playerSessions = {}
    this.reservations = {}
  }

  getHost() {
    return this.host
  }

  hasGame(gameUid) {
    return this.data.games[gameUid]
  }

  getPublicGames() {
    let result = {}

    for (let id in this.data.games) {
      let gameData = this.data.games[id]
      if (!gameData.isPrivate) {
        result[id] = gameData
      }
    }

    return result
  }


  triggerRestart() {
    let thirtySeconds = 30 * 1000

    clearTimeout(this.restartTimeout)

    this.restartTimeout = setTimeout(() => {
      this.restart()
    }, thirtySeconds)
  }

  restart() {
    if (debugMode) return // restart only for production/staging mode
    if (!this.getSocket()) return

    this.isRestarting = true

    SocketUtil.emit(this.getSocket(), "Restart", {})
  }

  getSocket() {
    return this.data.socket
  }

  onPlayerCountChanged() {
    let serverPlayerCount = this.getPlayerCount()
    if (serverPlayerCount === 0 && this.lastServerPlayerCount !== 0) {
      this.onPlayerCountReducedToZero()
    }

    if (serverPlayerCount > 0) {
      this.onPlayerCountAboveZero()
    }

    this.lastServerPlayerCount = serverPlayerCount
  }

  onPlayerCountAboveZero() {
  }

  onPlayerCountReducedToZero() {
  }

  isHighMemoryOnZeroPlayers() {
    return this.data.memory > 250
  }

  isHighMemory() {
    return this.data.memory > 800
  }

  isOldRevision() {
    if (debugMode) return false
    return this.revision !== this.matchmaker.latestRevision
  }

  update(data) {
    this.data = data
  }

  isTemporaryUnavailable() {
    if (this.isRestarting) return true
    if (this.isHighMemory()) return true
    if (this.isOldRevision()) return true

    return false
  }

  isAvailable(options = {}) {
    if (this.isTemporaryUnavailable()) return false
    return this.getPlayerCount() < 500
  }

  getStatusData() {
    return {
      host: this.host,
      memory: this.data.memory,
      playerCount: this.getPlayerCount(),
      revision: this.revision,
      systemdIndex: this.data.systemdIndex,
      gameCount: this.getGameCount(),
      debugPort: this.data.debugPort
    }
  }

  getGameCount() {
    return Object.keys(this.data.games).length
  }

  addPlayerSession(uid) {
    this.playerSessions[uid] = uid
  }

  removePlayerSession(uid) {
    delete this.playerSessions[uid]
  }

  getPlayerCount() {
    if (!this.data) return 0

    return this.data.playerCount
  }

  remove() {
    if (this.getPlayerCount() > 0) {
      this.region.addDisconnectedServer(this)
    }

    this.region.removeServer(this)

    for (let playerUid in this.playerSessions) {
      this.region.removePlayerSession(playerUid)
    }
  }


}

module.exports = Server
