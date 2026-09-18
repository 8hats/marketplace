export function pushWake(server, data, onError = () => {}) {
  try {
    const result = server.sendLoggingMessage({ level: 'info', logger: 'au-cowork-personal', data: JSON.stringify(data) });
    if (result?.then) void result.catch(onError);
  } catch (error) { onError(error); }
}
