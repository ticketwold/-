import type { RuntimeMessage } from '../types';

export function broadcast(msg: RuntimeMessage): void {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

export function sendRuntimeMessage<T = unknown>(msg: RuntimeMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response as T);
    });
  });
}
