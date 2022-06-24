const Region = require('./region')

class Environment {
  constructor(matchmaker, environment) {
    this.regions = {}
    this.matchmaker = matchmaker
    this.environment = environment

    this.REGION_LIST = ["ams2", "ams3", "blr1", "fra1", "lon1", "nyc1", "nyc2", "nyc3", 
                        "sfo1", "sfo2", "sgp1", "tor1", "localhost", "test"]
  }

  getRegion(regionName) {
    if (this.REGION_LIST.indexOf(regionName) === -1) return null

    let region = this.regions[regionName]
    if (!region) {
      region = new Region(this, regionName)
      this.regions[regionName] = region
    }

    return region
  }

  findSector(sectorId) {
    let sector

    for (let regionName in this.regions) {
      let region = this.regions[regionName]
      let nodes = region.nodes
      for (let nodeName in nodes) {
        let node = nodes[nodeName]
        let servers = node.servers
        for (let host in servers) {
          let server = servers[host]
          if (server.sectors[sectorId]) {
            sector = server.sectors[sectorId]
            break
          }
        }
      }
    }

    return sector
  }

  getSocketIds() {
    let result = []

    for (let regionName in this.regions) {
      let region = this.regions[regionName]
      result = result.concat(region.getSocketIds())
    }

    return result
  }

  getServersByRegion() {
    let result = {}

    for (let regionName in this.regions) {
      let region = this.regions[regionName] 
      result[regionName] = region.getServersJson()
    }
    
    return result
  }

  getOneServerByRegion() {
    let result = {}

    for (let regionName in this.regions) {
      let region = this.regions[regionName] 
      result[regionName] = region.getOneServerJson()
    }
    
    return result
  }

  forEachRegion(cb) {
    for (let regionName in this.regions) {
      cb(this.regions[regionName])
    }
  }
}

module.exports = Environment