/**
 * MCP Apps host v13 — 3 display mode: inline / fullscreen / pip (ideas only).
 *
 *   - `inline` — app nằm trong luồng chat, đúng chỗ kết quả tool trả
 *     về (mặc định; app nào cũng dùng được).
 *   - `fullscreen` — app chiếm toàn bộ vùng làm việc (editor, game,
 *     dashboard lớn). Chỉ MỘT app fullscreen tại một thời điểm: app
 *     khác xin fullscreen thì app đang fullscreen bị đưa về mode
 *     trước đó của nó (mặc định inline).
 *   - `pip` — picture-in-picture: cửa sổ nổi nhỏ, luôn hiển thị trên
 *     các view khác (monitoring, timer, media player). Có vị trí +
 *     kích thước riêng, kéo/thu phóng được trong viewport; nhiều app
 *     pip có thể mở cùng lúc (mỗi app một góc, không chồng nhau hoàn
 *     toàn — manager tự dời góc khi trùng).
 *
 * Manager này thuần (không DOM): renderer đọc snapshot để đặt style
 * cho iframe, và gọi `movePip`/`resizePip` khi user kéo. Mọi chuyển
 * mode đều qua `setMode` để luật "một fullscreen" và "pip không
 * chồng" được giữ ở một chỗ.
 */

export const APP_DISPLAY_MODES = ['inline', 'fullscreen', 'pip'] as const;
export type AppDisplayMode = (typeof APP_DISPLAY_MODES)[number];

/** Kích thước viewport host (px) — dùng để clamp cửa sổ pip. */
export interface AppViewport {
  width: number;
  height: number;
}

/** Hình học cửa sổ pip (px, tính từ góc trên-trái của viewport). */
export interface PipGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Góc neo mặc định của cửa sổ pip. */
export const PIP_ANCHORS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const;
export type PipAnchor = (typeof PIP_ANCHORS)[number];

/** Giới hạn kích thước pip (px). */
export const PIP_MIN_WIDTH = 240;
export const PIP_MIN_HEIGHT = 160;
export const PIP_MAX_WIDTH = 960;
export const PIP_MAX_HEIGHT = 720;
export const PIP_DEFAULT_WIDTH = 360;
export const PIP_DEFAULT_HEIGHT = 240;
/** Lề tối thiểu giữa cửa sổ pip và mép viewport (px). */
export const PIP_VIEWPORT_MARGIN = 8;
/** Độ dời khi hai cửa sổ pip trùng góc (px). */
export const PIP_CASCADE_OFFSET = 32;
/** Chiều cao mặc định của app inline (px) — renderer có thể override. */
export const INLINE_DEFAULT_HEIGHT = 360;
/** Chiều cao tối đa của app inline trước khi cuộn trong (px). */
export const INLINE_MAX_HEIGHT = 900;

export class DisplayModeError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'DisplayModeError';
    this.code = code;
  }
}

/** Trạng thái hiển thị của một app. */
export interface AppDisplayState {
  appId: string;
  mode: AppDisplayMode;
  /** Mode trước khi vào fullscreen/pip (để quay lại khi thoát). */
  previousMode: AppDisplayMode;
  /** Hình học pip (chỉ có nghĩa khi mode là pip). */
  pip: PipGeometry;
  /** Góc neo của cửa sổ pip. */
  pipAnchor: PipAnchor;
  /** Chiều cao inline (px). */
  inlineHeight: number;
  /** App có đang được user "ghim" (pip không tự đóng khi task xong). */
  pinned: boolean;
  updatedAtMs: number;
}

export interface DisplayModeManagerOptions {
  now?: () => number;
  viewport?: AppViewport;
  onChange?: (state: AppDisplayState) => void;
}

export type DisplayModeChangeListener = (state: AppDisplayState) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Parse + validate một display mode từ input ngoài (tool arg / app request). */
export function parseDisplayMode(value: unknown): AppDisplayMode {
  if (typeof value !== 'string' || !(APP_DISPLAY_MODES as readonly string[]).includes(value)) {
    throw new DisplayModeError(
      `Display mode phải là một trong: ${APP_DISPLAY_MODES.join(', ')}.`,
      'display-bad-mode',
    );
  }
  return value as AppDisplayMode;
}

/** True khi giá trị là display mode hợp lệ (không throw). */
export function isDisplayMode(value: unknown): value is AppDisplayMode {
  try {
    parseDisplayMode(value);
    return true;
  } catch {
    return false;
  }
}

/** Parse một góc neo pip. */
export function parsePipAnchor(value: unknown): PipAnchor {
  if (typeof value === 'string' && (PIP_ANCHORS as readonly string[]).includes(value)) {
    return value as PipAnchor;
  }
  return 'bottom-right';
}

/** Tính hình học pip mặc định cho một góc neo trong viewport cho trước. */
export function defaultPipGeometry(
  anchor: PipAnchor,
  viewport: AppViewport,
  size: { width?: number; height?: number } = {},
): PipGeometry {
  const width = clamp(size.width ?? PIP_DEFAULT_WIDTH, PIP_MIN_WIDTH, Math.min(PIP_MAX_WIDTH, viewport.width - PIP_VIEWPORT_MARGIN * 2));
  const height = clamp(size.height ?? PIP_DEFAULT_HEIGHT, PIP_MIN_HEIGHT, Math.min(PIP_MAX_HEIGHT, viewport.height - PIP_VIEWPORT_MARGIN * 2));
  const maxX = Math.max(PIP_VIEWPORT_MARGIN, viewport.width - width - PIP_VIEWPORT_MARGIN);
  const maxY = Math.max(PIP_VIEWPORT_MARGIN, viewport.height - height - PIP_VIEWPORT_MARGIN);
  switch (anchor) {
    case 'bottom-right':
      return { x: maxX, y: maxY, width, height };
    case 'bottom-left':
      return { x: PIP_VIEWPORT_MARGIN, y: maxY, width, height };
    case 'top-right':
      return { x: maxX, y: PIP_VIEWPORT_MARGIN, width, height };
    case 'top-left':
      return { x: PIP_VIEWPORT_MARGIN, y: PIP_VIEWPORT_MARGIN, width, height };
  }
}

/** Clamp hình học pip vào trong viewport (giữ nguyên kích thước khi có thể). */
export function clampPipGeometry(geometry: PipGeometry, viewport: AppViewport): PipGeometry {
  const width = clamp(geometry.width, PIP_MIN_WIDTH, Math.min(PIP_MAX_WIDTH, Math.max(PIP_MIN_WIDTH, viewport.width - PIP_VIEWPORT_MARGIN * 2)));
  const height = clamp(geometry.height, PIP_MIN_HEIGHT, Math.min(PIP_MAX_HEIGHT, Math.max(PIP_MIN_HEIGHT, viewport.height - PIP_VIEWPORT_MARGIN * 2)));
  const maxX = Math.max(PIP_VIEWPORT_MARGIN, viewport.width - width - PIP_VIEWPORT_MARGIN);
  const maxY = Math.max(PIP_VIEWPORT_MARGIN, viewport.height - height - PIP_VIEWPORT_MARGIN);
  return {
    x: clamp(geometry.x, PIP_VIEWPORT_MARGIN, maxX),
    y: clamp(geometry.y, PIP_VIEWPORT_MARGIN, maxY),
    width,
    height,
  };
}

/** Hai hình học pip có chồng nhau không (dùng để dời góc khi mở pip mới). */
export function pipOverlaps(a: PipGeometry, b: PipGeometry): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * Quản lý display mode của các app đang mở. Một instance cho toàn bộ
 * desktop; renderer subscribe `onChange` để cập nhật style.
 */
export class AppDisplayModeManager {
  private readonly now: () => number;
  private viewport: AppViewport;
  private readonly onChange?: DisplayModeManagerOptions['onChange'];
  private readonly states = new Map<string, AppDisplayState>();
  private readonly listeners = new Set<DisplayModeChangeListener>();

  constructor(options: DisplayModeManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.viewport = options.viewport ?? { width: 1280, height: 800 };
    this.onChange = options.onChange;
  }

  /** Viewport hiện tại (renderer cập nhật khi cửa sổ resize). */
  getViewport(): AppViewport {
    return { ...this.viewport };
  }

  /** Cập nhật viewport; các cửa sổ pip đang mở được clamp lại. */
  setViewport(viewport: AppViewport): void {
    this.viewport = {
      width: Math.max(320, Math.floor(viewport.width)),
      height: Math.max(240, Math.floor(viewport.height)),
    };
    for (const state of this.states.values()) {
      if (state.mode === 'pip') {
        state.pip = clampPipGeometry(state.pip, this.viewport);
        this.emit(state);
      }
    }
  }

  /** Đăng ký listener cho mọi thay đổi display state. Trả hàm huỷ. */
  onDisplayChange(listener: DisplayModeChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Đăng ký một app mới với mode ban đầu (mặc định inline). */
  register(
    appId: string,
    initial: { mode?: AppDisplayMode; pipAnchor?: PipAnchor; pipSize?: { width?: number; height?: number }; inlineHeight?: number } = {},
  ): AppDisplayState {
    const existing = this.states.get(appId);
    if (existing) return { ...existing, pip: { ...existing.pip } };
    const mode = parseDisplayMode(initial.mode ?? 'inline');
    const anchor = initial.pipAnchor ?? 'bottom-right';
    const state: AppDisplayState = {
      appId,
      mode,
      previousMode: 'inline',
      pip: defaultPipGeometry(anchor, this.viewport, initial.pipSize),
      pipAnchor: anchor,
      inlineHeight: clamp(initial.inlineHeight ?? INLINE_DEFAULT_HEIGHT, 120, INLINE_MAX_HEIGHT),
      pinned: false,
      updatedAtMs: this.now(),
    };
    this.states.set(appId, state);
    if (mode === 'fullscreen') this.demoteOtherFullscreen(appId);
    if (mode === 'pip') state.pip = this.cascadePip(state.pip, appId);
    this.emit(state);
    return this.snapshot(appId)!;
  }

  /** Lấy trạng thái hiển thị của một app (bản sao). */
  get(appId: string): AppDisplayState | undefined {
    return this.snapshot(appId);
  }

  /** Toàn bộ trạng thái (mới cập nhật nhất trước). */
  list(): AppDisplayState[] {
    return [...this.states.values()]
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .map((s) => this.snapshot(s.appId)!);
  }

  /** App nào đang fullscreen (tối đa một). */
  fullscreenAppId(): string | undefined {
    for (const s of this.states.values()) {
      if (s.mode === 'fullscreen') return s.appId;
    }
    return undefined;
  }

  /** Toàn bộ app đang pip. */
  pipAppIds(): string[] {
    return [...this.states.values()].filter((s) => s.mode === 'pip').map((s) => s.appId);
  }

  /**
   * Đổi display mode của một app. Luật:
   * - Vào fullscreen: app fullscreen cũ (nếu có) về `previousMode`.
   * - Vào pip: dời góc nếu trùng cửa sổ pip khác.
   * - Rời fullscreen/pip: về `previousMode` khi mode mới là inline
   *   và app đã lưu previousMode khác inline.
   * Ném `DisplayModeError` khi app chưa đăng ký.
   */
  setMode(appId: string, mode: AppDisplayMode): AppDisplayState {
    parseDisplayMode(mode);
    const state = this.states.get(appId);
    if (!state) {
      throw new DisplayModeError(`Không có app "${appId}" trong display manager.`, 'display-unknown-app');
    }
    if (state.mode === mode) return this.snapshot(appId)!;
    // Vào overlay (fullscreen/pip): nhớ mode hiện tại để thoát về đúng chỗ.
    if (mode === 'fullscreen' || mode === 'pip') {
      state.previousMode = state.mode;
    }
    state.mode = mode;
    state.updatedAtMs = this.now();
    if (mode === 'fullscreen') this.demoteOtherFullscreen(appId);
    if (mode === 'pip') state.pip = this.cascadePip(state.pip, appId);
    this.emit(state);
    return this.snapshot(appId)!;
  }

  /** Thoát fullscreen/pip về mode trước đó (nút đóng / Esc). */
  exitOverlay(appId: string): AppDisplayState {
    const state = this.states.get(appId);
    if (!state) {
      throw new DisplayModeError(`Không có app "${appId}" trong display manager.`, 'display-unknown-app');
    }
    return this.setMode(appId, state.previousMode);
  }

  /** Đổi fullscreen <-> pip <-> inline theo vòng (phím tắt của host). */
  cycleMode(appId: string): AppDisplayState {
    const state = this.states.get(appId);
    if (!state) {
      throw new DisplayModeError(`Không có app "${appId}" trong display manager.`, 'display-unknown-app');
    }
    const next: AppDisplayMode =
      state.mode === 'inline' ? 'fullscreen' : state.mode === 'fullscreen' ? 'pip' : 'inline';
    return this.setMode(appId, next);
  }

  /** Di chuyển cửa sổ pip (kéo thả). Clamp vào viewport. */
  movePip(appId: string, x: number, y: number): AppDisplayState {
    const state = this.requirePip(appId);
    state.pip = clampPipGeometry({ ...state.pip, x: Math.floor(x), y: Math.floor(y) }, this.viewport);
    state.updatedAtMs = this.now();
    this.emit(state);
    return this.snapshot(appId)!;
  }

  /** Đổi kích thước cửa sổ pip (kéo góc). Clamp theo giới hạn + viewport. */
  resizePip(appId: string, width: number, height: number): AppDisplayState {
    const state = this.requirePip(appId);
    state.pip = clampPipGeometry(
      { ...state.pip, width: Math.floor(width), height: Math.floor(height) },
      this.viewport,
    );
    state.updatedAtMs = this.now();
    this.emit(state);
    return this.snapshot(appId)!;
  }

  /** Đặt góc neo cho cửa sổ pip (dời về góc đó, giữ kích thước). */
  anchorPip(appId: string, anchor: PipAnchor): AppDisplayState {
    const state = this.requirePip(appId);
    state.pipAnchor = anchor;
    state.pip = this.cascadePip(defaultPipGeometry(anchor, this.viewport, state.pip), appId);
    state.updatedAtMs = this.now();
    this.emit(state);
    return this.snapshot(appId)!;
  }

  /** Ghim / bỏ ghim app pip (ghim thì task xong cũng không tự đóng). */
  setPinned(appId: string, pinned: boolean): AppDisplayState {
    const state = this.states.get(appId);
    if (!state) {
      throw new DisplayModeError(`Không có app "${appId}" trong display manager.`, 'display-unknown-app');
    }
    state.pinned = pinned;
    state.updatedAtMs = this.now();
    this.emit(state);
    return this.snapshot(appId)!;
  }

  /** Đặt chiều cao inline của app (px, clamp 120..900). */
  setInlineHeight(appId: string, height: number): AppDisplayState {
    const state = this.states.get(appId);
    if (!state) {
      throw new DisplayModeError(`Không có app "${appId}" trong display manager.`, 'display-unknown-app');
    }
    state.inlineHeight = clamp(Math.floor(height), 120, INLINE_MAX_HEIGHT);
    state.updatedAtMs = this.now();
    this.emit(state);
    return this.snapshot(appId)!;
  }

  /** Gỡ app khỏi manager (khi app đóng). Trả true khi app tồn tại. */
  unregister(appId: string): boolean {
    return this.states.delete(appId);
  }

  /** Gỡ toàn bộ. */
  clear(): void {
    this.states.clear();
  }

  /** Serialise toàn bộ trạng thái (để khôi phục sau restart renderer). */
  serialize(): AppDisplayState[] {
    return this.list();
  }

  /** Khôi phục trạng thái đã serialise (clamp lại theo viewport hiện tại). */
  restore(states: readonly AppDisplayState[]): void {
    for (const saved of states) {
      if (!isRecord(saved) || typeof saved.appId !== 'string') continue;
      const mode = isDisplayMode(saved.mode) ? saved.mode : 'inline';
      const state: AppDisplayState = {
        appId: saved.appId,
        mode,
        previousMode: isDisplayMode(saved.previousMode) ? saved.previousMode : 'inline',
        pip: clampPipGeometry(
          isRecord(saved.pip)
            ? {
                x: typeof saved.pip['x'] === 'number' ? saved.pip['x'] : PIP_VIEWPORT_MARGIN,
                y: typeof saved.pip['y'] === 'number' ? saved.pip['y'] : PIP_VIEWPORT_MARGIN,
                width: typeof saved.pip['width'] === 'number' ? saved.pip['width'] : PIP_DEFAULT_WIDTH,
                height: typeof saved.pip['height'] === 'number' ? saved.pip['height'] : PIP_DEFAULT_HEIGHT,
              }
            : defaultPipGeometry('bottom-right', this.viewport),
          this.viewport,
        ),
        pipAnchor: parsePipAnchor(saved.pipAnchor),
        inlineHeight: clamp(
          typeof saved.inlineHeight === 'number' ? saved.inlineHeight : INLINE_DEFAULT_HEIGHT,
          120,
          INLINE_MAX_HEIGHT,
        ),
        pinned: saved.pinned === true,
        updatedAtMs: this.now(),
      };
      this.states.set(state.appId, state);
    }
    // Sau restore, luật một-fullscreen vẫn phải giữ.
    const fullscreen = [...this.states.values()].filter((s) => s.mode === 'fullscreen');
    for (const extra of fullscreen.slice(1)) {
      extra.mode = extra.previousMode;
    }
  }

  private snapshot(appId: string): AppDisplayState | undefined {
    const s = this.states.get(appId);
    if (!s) return undefined;
    return { ...s, pip: { ...s.pip } };
  }

  private requirePip(appId: string): AppDisplayState {
    const state = this.states.get(appId);
    if (!state) {
      throw new DisplayModeError(`Không có app "${appId}" trong display manager.`, 'display-unknown-app');
    }
    if (state.mode !== 'pip') {
      throw new DisplayModeError(
        `App "${appId}" không ở mode pip (đang ở ${state.mode}) — không di chuyển được.`,
        'display-not-pip',
      );
    }
    return state;
  }

  /** App fullscreen khác (nếu có) về mode trước đó của nó. */
  private demoteOtherFullscreen(exceptAppId: string): void {
    for (const other of this.states.values()) {
      if (other.appId !== exceptAppId && other.mode === 'fullscreen') {
        other.mode = other.previousMode;
        other.updatedAtMs = this.now();
        this.emit(other);
      }
    }
  }

  /** Dời hình học pip từng bước 32px cho tới khi hết trùng cửa sổ pip khác. */
  private cascadePip(geometry: PipGeometry, appId: string): PipGeometry {
    let candidate = clampPipGeometry(geometry, this.viewport);
    for (let step = 0; step < 20; step += 1) {
      const collides = [...this.states.values()].some(
        (other) => other.appId !== appId && other.mode === 'pip' && pipOverlaps(candidate, other.pip),
      );
      if (!collides) return candidate;
      candidate = clampPipGeometry(
        { ...candidate, x: candidate.x - PIP_CASCADE_OFFSET, y: candidate.y - PIP_CASCADE_OFFSET },
        this.viewport,
      );
    }
    return candidate;
  }

  private emit(state: AppDisplayState): void {
    const snapshot = this.snapshot(state.appId)!;
    this.onChange?.(snapshot);
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Một listener lỗi không được làm chết manager.
      }
    }
  }
}
