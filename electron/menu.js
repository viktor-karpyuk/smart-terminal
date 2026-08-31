'use strict';
const { Menu, app, shell } = require('electron');

/**
 * App menu. Accelerators live here rather than in the renderer so they fire
 * reliably even while xterm has keyboard focus.
 */
function buildMenu(send, newWindow) {
  const isMac = process.platform === 'darwin';
  const action = (id) => () => send('menu:action', { id });

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Accounts…', accelerator: 'Cmd+,', click: action('profiles') },
              { label: 'Usage limits…', accelerator: 'Cmd+U', click: action('usage') },
              { label: 'Appearance…', accelerator: 'Cmd+Shift+,', click: action('appearance') },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        // Copy is not a role: a terminal's selection is drawn, not part of the
        // document, so the system copy would find nothing to take.
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: action('copy') },
        // Paste stays a role so the text reaches the terminal as a real paste
        // event, which is what makes it arrive bracketed.
        { role: 'paste' },
        { type: 'separator' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: action('select-all') },
      ],
    },
    {
      label: 'Session',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => newWindow() },
        { type: 'separator' },
        { label: 'New Claude Session', accelerator: 'CmdOrCtrl+T', click: action('new-claude') },
        { label: 'New Shell', accelerator: 'CmdOrCtrl+Shift+T', click: action('new-shell') },
        { label: 'Duplicate Session', accelerator: 'CmdOrCtrl+Shift+K', click: action('duplicate') },
        { type: 'separator' },
        { label: 'Close Session', accelerator: 'CmdOrCtrl+W', click: action('close') },
        { label: 'Restart Session', accelerator: 'CmdOrCtrl+R', click: action('restart') },
        { label: 'Run Claude in This Tab', accelerator: 'CmdOrCtrl+Return', click: action('run-claude') },
        { type: 'separator' },
        { label: 'Rename Session…', accelerator: 'CmdOrCtrl+E', click: action('rename') },
        { type: 'separator' },
        { label: 'History…', accelerator: 'CmdOrCtrl+Y', click: action('history') },
      ],
    },
    {
      label: 'Layout',
      submenu: [
        { label: 'Split Right', accelerator: 'CmdOrCtrl+D', click: action('split-right') },
        { label: 'Split Down', accelerator: 'CmdOrCtrl+Shift+D', click: action('split-down') },
        { type: 'separator' },
        { label: 'Focus Left', accelerator: 'CmdOrCtrl+Alt+Left', click: action('focus-left') },
        { label: 'Focus Right', accelerator: 'CmdOrCtrl+Alt+Right', click: action('focus-right') },
        { label: 'Focus Up', accelerator: 'CmdOrCtrl+Alt+Up', click: action('focus-up') },
        { label: 'Focus Down', accelerator: 'CmdOrCtrl+Alt+Down', click: action('focus-down') },
        { type: 'separator' },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: action('next-tab') },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: action('prev-tab') },
        { type: 'separator' },
        { label: 'Close Pane', accelerator: 'CmdOrCtrl+Alt+W', click: action('close-pane') },
        { label: 'Even Out Splits', accelerator: 'CmdOrCtrl+Alt+0', click: action('even-splits') },
        { label: 'Maximize Pane', accelerator: 'CmdOrCtrl+Alt+Enter', click: action('toggle-zoom') },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: action('toggle-sidebar') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Find in Terminal', accelerator: 'CmdOrCtrl+F', click: action('find') },
        { label: 'Clear Terminal', accelerator: 'CmdOrCtrl+K', click: action('clear') },
        { type: 'separator' },
        { label: 'Bigger Text', accelerator: 'CmdOrCtrl+=', click: action('font-bigger') },
        // The same command under the shifted and numpad keys, since one label can
        // only advertise one of them but people press all three.
        { label: 'Bigger Text', accelerator: 'CmdOrCtrl+Plus', click: action('font-bigger'), visible: false },
        { label: 'Bigger Text', accelerator: 'CmdOrCtrl+numadd', click: action('font-bigger'), visible: false },
        { label: 'Smaller Text', accelerator: 'CmdOrCtrl+-', click: action('font-smaller') },
        { label: 'Smaller Text', accelerator: 'CmdOrCtrl+numsub', click: action('font-smaller'), visible: false },
        { label: 'Reset Text Size', accelerator: 'CmdOrCtrl+0', click: action('font-reset') },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'reload' },
      ],
    },
    {
      role: 'windowMenu',
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Claude Code Docs',
          click: () => shell.openExternal('https://docs.claude.com/en/docs/claude-code/overview'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
