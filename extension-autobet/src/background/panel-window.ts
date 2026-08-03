let panelWindowId: number | null = null;

export async function openPanel(): Promise<number> {
  if (panelWindowId != null) {
    try {
      await chrome.windows.get(panelWindowId);
      await chrome.windows.update(panelWindowId, { focused: true, drawAttention: true });
      const tabs = await chrome.tabs.query({ windowId: panelWindowId });
      if (tabs[0]?.id) await chrome.tabs.update(tabs[0].id, { active: true });
      return panelWindowId;
    } catch {
      panelWindowId = null;
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('panel.html'),
    type: 'popup',
    width: 460,
    height: 780,
    focused: true,
  });
  if (!win?.id) throw new Error('패널 창 생성 실패');
  panelWindowId = win.id;
  return panelWindowId;
}

chrome.action.onClicked.addListener(() => {
  void openPanel();
});

chrome.windows.onRemoved.addListener((id) => {
  if (id === panelWindowId) panelWindowId = null;
});
