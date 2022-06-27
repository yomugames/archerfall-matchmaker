const admin = require('firebase-admin')
const jwt = require('jsonwebtoken')
const LOG = require('archerfall-common/logger')

class FirebaseAdminHelper {
  static init() {
    if (!this.isInitialized) {
      if (!global.isOffline) {
        admin.initializeApp({
          credential: admin.credential.applicationDefault(),
        })
      }

      this.isInitialized = true
    }
  }

  static verifyIdToken(idToken) {
    if (!idToken) return null

    return admin
      .auth()
      .verifyIdToken(idToken)
      .then((decodedToken) => {
        const uid = decodedToken.uid;
        return uid
      })
      .catch((e) => {
        return null
      })
  }

  static watchNodeRevision(region, nodeName, callback) {
    let revisionRef = admin.database().ref(`/nodes/${region}/${nodeName}/revision`)

    revisionRef.on('value', (snapshot) => {
      callback(snapshot.val())
    })

    return revisionRef
  }

  static async setServerSectors(region, serverKey, sectorIds) {
    let serverSectorRef = admin.database()
      .ref(`/servers/${region}/${serverKey}/sectors/`)
    await serverSectorRef.remove()

    for (var i = 0; i < sectorIds.length; i++) {
      let sectorId = sectorIds[i]
      let serverSectorRef = admin.database()
        .ref(`/servers/${region}/${serverKey}/sectors/${sectorId}`)
      await serverSectorRef.set(true)
    }

  }

  static async removeSectorFromServer(region, serverKey, sectorId) {
    let serverSectorRef = admin.database()
      .ref(`/servers/${region}/${serverKey}/sectors/${sectorId}`)
    await serverSectorRef.remove()
  }

  static async registerServerToNode(region, nodeKey, serverKey) {
    if (global.isOffline) return false

    let nodeServerDataRef = admin.database().ref(`/nodes/${region}/${nodeKey}/servers/${serverKey}`)
    await nodeServerDataRef.set(true)
  }

  static async removeServerFromNode(region, nodeKey, serverKey) {
    if (global.isOffline) return false

    let nodeServerDataRef = admin.database().ref(`/nodes/${region}/${nodeKey}/servers/${serverKey}`)
    await nodeServerDataRef.remove()
  }

  static async removeServer(region, serverKey) {
    if (global.isOffline) return false

    let serverDataRef = admin.database().ref(`/servers/${region}/${serverKey}`)
    await serverDataRef.remove()
  }

  static async setRegionNodeCount(region, nodeCount) {
    if (global.isOffline) return false

    let nodeCountRef = admin.database().ref(`/nodes/${region}/nodeCount`)
    await nodeCountRef.set(nodeCount)
  }

  static async setAdditionalNodeNeeded(region, additionalNodeNeeded) {
    if (global.isOffline) return false

    let additionalNodeNeededRef = admin.database().ref(`/nodes/${region}/additionalNodeNeeded`)
    await additionalNodeNeededRef.set(additionalNodeNeeded)
  }

  static async setNodeToShutdown(region, nodeName) {
    if (global.isOffline) return false

    let nodeRef = admin.database().ref(`/nodes/${region}/nodesToShutdown/${nodeName}`)
    await nodeRef.set(true)
  }

}

module.exports = FirebaseAdminHelper
