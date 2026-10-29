import { chooseBotMove } from './engine.js?v=20261029-1';

self.onmessage = (event) => {
  const { id, fen, level } = event.data || {};
  try {
    const move = chooseBotMove(fen, level);
    self.postMessage({ id, move });
  } catch (err) {
    self.postMessage({ id, move: null, error: String(err) });
  }
};
