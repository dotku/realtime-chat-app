export function loadAgentsFromStorage() {
  try {
    return JSON.parse(localStorage.getItem('chat_agents') || '[]');
  } catch { return []; }
}

export function saveAgentsToStorage(agents) {
  localStorage.setItem('chat_agents', JSON.stringify(agents));
}
