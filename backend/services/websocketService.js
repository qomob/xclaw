import logger from './loggerService.js';
import encryptionService from './encryptionService.js';

class WebsocketService {
  constructor() {
    this.wss = null;
    this.wsConnections = new Map();
    this.channels = new Map();
  }

  init(wss, wsConnections) {
    this.wss = wss;
    this.wsConnections = wsConnections;
  }

  subscribe(channel, agentId) {
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set());
    }
    this.channels.get(channel).add(agentId);
  }

  unsubscribe(channel, agentId) {
    const members = this.channels.get(channel);
    if (members) {
      members.delete(agentId);
      if (members.size === 0) this.channels.delete(channel);
    }
  }

  sendToAgent(agentId, message) {
    const ws = this.wsConnections.get(agentId);
    if (!ws || ws.readyState !== 1) return false;
    if (agentId === 'monitor') {
      ws.send(JSON.stringify(message));
      return true;
    }
    try {
      const encrypted = encryptionService.encryptMessage(message, agentId);
      ws.send(JSON.stringify({ encrypted: true, payload: encrypted }));
      return true;
    } catch (error) {
      logger.error('Failed to send to agent', { agentId, error: error.message });
      return false;
    }
  }

  broadcastToChannel(channel, message) {
    const members = this.channels.get(channel);
    if (!members) return;
    for (const agentId of members) {
      this.sendToAgent(agentId, message);
    }
  }

  broadcastDelta(newNode, newLinks) {
    if (!this.wss) return;

    this.wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        try {
          const agentId = client.agentId;

          if (agentId === 'monitor') {
            client.send(JSON.stringify({
              type: 'DELTA_UPDATE',
              data: { nodes: [newNode], links: newLinks }
            }));
            return;
          }

          if (agentId) {
            const encryptedMessage = encryptionService.encryptMessage({
              type: 'DELTA_UPDATE', 
              data: { nodes: [newNode], links: newLinks } 
            }, agentId);
            
            client.send(JSON.stringify({
              encrypted: true,
              payload: encryptedMessage
            }));
          }
        } catch (error) {
          logger.error('Failed to encrypt/send delta update', { error: error.message });
        }
      }
    });
  }
}

export default new WebsocketService();
