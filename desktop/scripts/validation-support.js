function sessionFromSnapshot(snapshot, threadId) {
  return snapshot?.type === 'snapshot'
    ? snapshot.sessions?.find((session) => session.id === threadId) || null
    : null;
}

function waitForSessionState({ socket, threadId, initialSnapshot, expectedState, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const finish = (session) => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(session);
    };
    const onMessage = (raw) => {
      let snapshot;
      try {
        snapshot = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const session = sessionFromSnapshot(snapshot, threadId);
      if (session?.state === expectedState) finish(session);
    };
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`timed out waiting for monitor snapshot state ${expectedState}`));
    }, timeoutMs);
    socket.on('message', onMessage);
    const initialSession = sessionFromSnapshot(initialSnapshot, threadId);
    if (initialSession?.state === expectedState) finish(initialSession);
  });
}

module.exports = { waitForSessionState };
