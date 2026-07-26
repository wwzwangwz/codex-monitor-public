function installTerminationHandlers({ processRef = process, quit }) {
  if (typeof quit !== 'function') throw new Error('quit callback is required');
  let quitting = false;
  const requestQuit = () => {
    if (quitting) return;
    quitting = true;
    quit();
  };
  processRef.on('SIGTERM', requestQuit);
  processRef.on('SIGINT', requestQuit);
  return () => {
    processRef.removeListener('SIGTERM', requestQuit);
    processRef.removeListener('SIGINT', requestQuit);
  };
}

module.exports = { installTerminationHandlers };
