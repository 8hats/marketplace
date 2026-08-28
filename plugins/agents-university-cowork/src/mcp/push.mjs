export function pushWake(server, data, onError = () => {}) {
  try {
    const result = server.sendLoggingMessage({ level: 'info', logger: 'agents-university-cowork', data: JSON.stringify(data) });
    if (result?.then) void result.catch(onError);
  } catch (error) { onError(error); }
}
