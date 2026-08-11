/**
 * ws.js — WebSocket connection manager
 *
 * Auto-reconnects. Dispatches events to update stores.
 */

import { getToken } from './api.js';
import {
  wsStatus, appState, messages, llmLogs, llmStats,
  addMessage, handleLLMCall, handleLLMResponse, handleLLMRetry, handleLLMInit, setTokenPricing,
  handleCodeActProgress, handleRecordingEvent,
} from './stores.js';
import { get } from 'svelte/store';

let ws = null;

/** 生态实时事件订阅者（8.0：ecosystem:* 增量事件透传给面板） */
const ecosystemListeners = new Set();

/** 订阅生态事件（federation/negotiation/conflict/evolution/governance-v2），返回取消订阅函数 */
export function onEcosystemEvent(cb) {
  ecosystemListeners.add(cb);
  return () => ecosystemListeners.delete(cb);
}

export function connectWS() {
  const token = getToken();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}/ws?token=${token}`;

  ws = new WebSocket(url);

  ws.onopen = () => {
    wsStatus.set('connected');
  };

  ws.onclose = () => {
    wsStatus.set('disconnected');
    setTimeout(connectWS, 3000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (ev) => {
    try {
      const event = JSON.parse(ev.data);
      handleEvent(event);
    } catch { /* ignore */ }
  };
}

/** 发送命令到服务端（如 llm:cancel） */
export function sendCommand(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function handleEvent(event) {
  switch (event.type) {
    case 'snapshot': {
      const data = event.data;
      appState.set(data);
      // Token pricing config
      if (data.tokenPricing) {
        setTokenPricing(data.tokenPricing);
      }
      break;
    }
    case 'nc:message':
      addMessage(event.data, event.timestamp);
      break;
    case 'queue:update': {
      appState.update(s => {
        s.queue = event.data;
        return s;
      });
      break;
    }
    case 'llm:call':
      handleLLMCall(event.data);
      break;
    case 'llm:response':
      handleLLMResponse(event.data);
      break;
    case 'llm:retry':
      handleLLMRetry(event.data);
      break;
    case 'llm:init':
      handleLLMInit(event.data);
      break;
    case 'codeact:progress':
      handleCodeActProgress(event.data);
      break;
    case 'recording:flush-start':
    case 'recording:flush-complete':
    case 'recording:flush-error':
    case 'recording:topics-signaled':
      handleRecordingEvent({ ...event.data, _type: event.type, _timestamp: event.timestamp });
      break;
    case 'federation:promoted':
    case 'negotiation:published':
    case 'negotiation:awarded':
    case 'negotiation:withdrawn':
    case 'conflict:resolved':
    case 'evolution:approved':
    case 'evolution:rejected':
    case 'governance-v2:updated':
    case 'governance-v2:rolled-back':
    case 'governance-v2:kill-switch':
      ecosystemListeners.forEach(cb => { try { cb(event); } catch { /* ignore */ } });
      break;
  }
}
