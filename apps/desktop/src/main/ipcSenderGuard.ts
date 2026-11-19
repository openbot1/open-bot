/**
 * Main-process IPC sender validation.
 *
 * Only the top-level frame of the primary application BrowserWindow may
 * invoke privileged main-process handlers. The caller supplies the exact
 * renderer URL used by createWindow (packaged file:// URL or the fixed dev
 * server URL); a URL from a remote page or child frame is never trusted.
 *
 * This module is deliberately structural so its security decisions can be
 * unit-tested without starting Electron.
 */

export interface IpcSenderFrameLike {
  readonly url: string;
  readonly frameTreeNodeId: number;
  readonly parent: IpcSenderFrameLike | null;
}

export interface IpcSenderWebContentsLike {
  readonly id: number;
  isDestroyed(): boolean;
  getURL(): string;
  readonly mainFrame: IpcSenderFrameLike;
}

export interface IpcSenderWindowLike {
  isDestroyed(): boolean;
  readonly webContents: IpcSenderWebContentsLike;
}

export interface IpcSenderEventLike {
  readonly sender: IpcSenderWebContentsLike;
  readonly senderFrame: IpcSenderFrameLike | null;
}

function matchesRendererUrl(candidate: string, expected: string): boolean {
  try {
    const actual = new URL(candidate);
    const trusted = new URL(expected);

    if (actual.protocol !== trusted.protocol) return false;
    if (actual.username !== '' || actual.password !== '') return false;

    // file:// has an opaque origin, so compare the exact local renderer file.
    if (trusted.protocol === 'file:') {
      return actual.host === trusted.host && actual.pathname === trusted.pathname;
    }

    // For development, require the exact protocol, host, port and pathname.
    // Query/hash are intentionally ignored because Vite may append HMR state.
    return actual.origin === trusted.origin && actual.pathname === trusted.pathname;
  } catch {
    return false;
  }
}

/**
 * Returns true only for the primary BrowserWindow's top-level renderer frame.
 * A matching URL alone is not sufficient: both WebContents id and frame
 * identity are checked to prevent other windows/iframes from borrowing trust.
 */
export function isTrustedMainWindowIpcSender(
  event: IpcSenderEventLike | null | undefined,
  mainWindow: IpcSenderWindowLike | null | undefined,
  expectedRendererUrl: string,
): boolean {
  try {
    if (!event || !mainWindow || mainWindow.isDestroyed()) return false;

    const expectedContents = mainWindow.webContents;
    const sender = event.sender;
    if (!expectedContents || expectedContents.isDestroyed() || !sender || sender.isDestroyed()) {
      return false;
    }

    if (!Number.isSafeInteger(expectedContents.id) || sender.id !== expectedContents.id) {
      return false;
    }

    const senderFrame = event.senderFrame;
    const mainFrame = sender.mainFrame;
    if (!senderFrame || !mainFrame) return false;

    // A top-level frame has no parent and shares the frame-tree node id with
    // WebContents.mainFrame. Subframes are not allowed to invoke privileged IPC.
    if (senderFrame.parent !== null || senderFrame.frameTreeNodeId !== mainFrame.frameTreeNodeId) {
      return false;
    }

    return (
      matchesRendererUrl(senderFrame.url, expectedRendererUrl) &&
      matchesRendererUrl(sender.getURL(), expectedRendererUrl)
    );
  } catch {
    // Detached frames and destroyed WebContents fail closed.
    return false;
  }
}

/** Throws from ipcMain.handle so the renderer's invoke promise is rejected. */
export function assertTrustedMainWindowIpcSender(
  event: IpcSenderEventLike | null | undefined,
  mainWindow: IpcSenderWindowLike | null | undefined,
  expectedRendererUrl: string,
  channel: string,
): void {
  if (isTrustedMainWindowIpcSender(event, mainWindow, expectedRendererUrl)) return;

  const error = new Error(`Blocked IPC invocation from an untrusted renderer (${channel}).`) as Error & {
    code: string;
  };
  error.code = 'ERR_IPC_UNTRUSTED_SENDER';
  throw error;
}
