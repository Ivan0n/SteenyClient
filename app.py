import os
import sys
import time
import json
import threading

from PyQt6.QtWidgets import (QApplication, QMainWindow, QWidget, QHBoxLayout,
                             QPushButton, QSpacerItem, QSizePolicy, QVBoxLayout,
                             QSystemTrayIcon, QMenu)
from PyQt6.QtWebEngineWidgets import QWebEngineView
from PyQt6.QtWebEngineCore import QWebEngineSettings
from PyQt6.QtCore import QUrl, QObject, pyqtSlot, Qt, QPropertyAnimation, QEasingCurve, QTimer
from PyQt6.QtWebChannel import QWebChannel
from PyQt6.QtGui import (QIcon, QDesktopServices, QAction, QPixmap, QPainter,
                         QColor, QFont)
from PyQt6.QtWebEngineCore import QWebEngineProfile, QWebEnginePage
from PyQt6.QtCore import QEvent

from pypresence import Presence
import subprocess
import ctypes


def _application_icon():
    """Load the packaged icon or build a visible fallback for the tray."""
    icon = QIcon(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              'icon.ico'))
    if not icon.isNull():
        return icon

    pixmap = QPixmap(64, 64)
    pixmap.fill(Qt.GlobalColor.transparent)
    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    painter.setBrush(QColor('#8b5cf6'))
    painter.setPen(Qt.PenStyle.NoPen)
    painter.drawEllipse(2, 2, 60, 60)
    font = QFont('Segoe UI', 34, QFont.Weight.Bold)
    painter.setFont(font)
    painter.setPen(QColor('#ffffff'))
    painter.drawText(pixmap.rect(), Qt.AlignmentFlag.AlignCenter, 'S')
    painter.end()
    return QIcon(pixmap)

# ── Discord RPC ──────────────────────────────────────────────────────────────
_RPC_CLIENT_ID = '1395388116105429195'
_rpc: Presence | None = None
_rpc_lock = threading.Lock()
_rpc_connecting = False
# Compatibility ladder for the Spotify-style card (see _do_rpc_update):
# 0 = LISTENING type + status_display_type, 1 = LISTENING type only,
# 2 = legacy typeless activity. Bumped when Discord rejects the payload, so
# older Discord clients degrade gracefully instead of erroring forever.
_rpc_compat = 0
# Last state received from the frontend — re-sent after a reconnect.
_rpc_last_json: str | None = None
# Fingerprint of the last activity Discord accepted: (key, start, end).
# Re-sending an identical card would only burn the rate limit.
_rpc_last_sent = None

try:
    from pypresence import ServerError as _RPCServerError
except ImportError:  # very old pypresence without exported exceptions
    class _RPCServerError(Exception):
        pass


def _rpc_init():
    """Connect to Discord. Runs in a background thread. Spotify-style: no
    idle card — presence appears only while something is actually playing."""
    global _rpc, _rpc_connecting
    with _rpc_lock:
        if _rpc_connecting:
            return
        _rpc_connecting = True
    try:
        p = Presence(_RPC_CLIENT_ID)
        p.connect()
        with _rpc_lock:
            global _rpc
            _rpc = p
        print('Discord RPC подключён')
        # After a (re)connect Discord knows nothing about us — push the last
        # known state instead of waiting for the next play/pause/seek event,
        # which could be minutes away (stale or missing card until then).
        # Drop the dedup fingerprint first: Discord's slate is blank now.
        global _rpc_last_sent
        _rpc_last_sent = None
        if _rpc_last_json:
            _do_rpc_update(_rpc_last_json)
    except Exception as e:
        print(f'Discord RPC: не удалось подключиться ({e})')
    finally:
        with _rpc_lock:
            _rpc_connecting = False


def _rpc_reconnect():
    """Wait a bit, then try to reconnect (called after a failed update)."""
    time.sleep(8)
    _rpc_init()


def _rpc_set_activity(rpc, activity):
    """Raw SET_ACTIVITY over pypresence's own transport. Needed because
    Presence.update() can't send an activity `type`, and type 2 (LISTENING)
    is exactly what makes Discord render the Spotify-style "Listening to"
    card with the progress slider."""
    payload = {
        'cmd': 'SET_ACTIVITY',
        'args': {'pid': os.getpid(), 'activity': activity},
        'nonce': f'{time.time():.20f}',
    }
    rpc.send_data(1, payload)
    return rpc.loop.run_until_complete(rpc.read_output())


def _do_rpc_update(data_json: str):
    """Build and send the activity in a background thread — never blocks the
    Qt main thread."""
    global _rpc, _rpc_compat, _rpc_last_json, _rpc_last_sent
    try:
        data = json.loads(data_json)
    except Exception:
        return
    # Remember the freshest state for the post-reconnect resend. The position
    # inside grows stale, but timestamps are recomputed against wall time on
    # the next real event anyway — a stale card beats a missing one.
    _rpc_last_json = data_json

    title     = (data.get('title')     or 'Неизвестный трек').strip()
    artist    = (data.get('artist')    or '').strip()
    lyric     = ' '.join(str(data.get('lyric') or '').split()).strip()[:128]
    cover_url = (data.get('cover_url') or '').strip()
    position  = float(data.get('position', 0) or 0)
    duration  = float(data.get('duration', 0) or 0)
    playing   = bool(data.get('playing', False))
    show_time = bool(data.get('show_time', True))

    # Spotify hides its presence while paused — do the same.
    if not playing:
        _do_rpc_clear()
        return

    # Use external cover only if it's a public HTTPS URL
    large_image = cover_url if cover_url.startswith('https://') else 'prew'

    # The beta lyrics mode uses the current synced line as Discord's secondary
    # text and promotes that field into the member-list status. Short/empty
    # lines fall back to the artist because Discord rejects malformed state
    # fields and one bad lyric must not break the whole card.
    using_lyric = len(lyric) >= 2
    state_text = lyric if using_lyric else artist
    hover_text = f'{title} — {artist}' if using_lyric and artist else title

    activity = {
        'type': 2,  # LISTENING → "Слушает STEENY" + progress slider
        # State (1) makes the live lyric visible as the member-list status;
        # Details (2) keeps Spotify-like track titles when lyrics are disabled
        # or temporarily unavailable.
        'status_display_type': 1 if using_lyric else 2,
        'details': title,
        'assets': {
            'large_image': large_image,
            'large_text': hover_text[:128],
            'small_image': 'logo',
            'small_text': 'STEENY',
        },
    }
    if state_text:
        activity['state'] = state_text[:128]
    if show_time and duration > 1:
        now = time.time()
        activity['timestamps'] = {
            'start': int(now - position),
            'end':   int(now - position + duration),
        }
    elif show_time:
        activity['timestamps'] = {'start': int(time.time() - position)}

    # Skip if Discord is already showing exactly this card (same track and
    # cover, timeline within 3 s). Bursts like play+durationchange and the
    # frontend's minute-refresh collapse to nothing here instead of burning
    # the ~5-updates-per-20s SET_ACTIVITY budget — hitting that limit is
    # what froze the card on a previous track.
    ts = activity.get('timestamps') or {}
    fingerprint = (activity.get('details'), activity.get('state'), large_image)
    if _rpc_last_sent:
        f2, s2, e2 = _rpc_last_sent
        if (f2 == fingerprint
                and abs(ts.get('start', 0) - s2) <= 3
                and abs(ts.get('end', 0) - e2) <= 3):
            return

    # Degrade gracefully on older Discord clients: drop status_display_type
    # first, then the LISTENING type. The working level is remembered.
    attempts = [activity]
    attempts.append({k: v for k, v in activity.items()
                     if k != 'status_display_type'})
    attempts.append({k: v for k, v in attempts[1].items() if k != 'type'})

    with _rpc_lock:
        rpc = _rpc
    if rpc is None:
        return

    for level in range(_rpc_compat, len(attempts)):
        try:
            _rpc_set_activity(rpc, attempts[level])
            _rpc_compat = level
            _rpc_last_sent = (fingerprint, ts.get('start', 0), ts.get('end', 0))
            return
        except _RPCServerError:
            continue  # payload rejected — try the next, simpler shape
        except Exception as e:
            # Transport error (Discord closed, pipe broke) — reconnect.
            print(f'Discord RPC update error: {e}')
            with _rpc_lock:
                _rpc = None
            threading.Thread(target=_rpc_reconnect, daemon=True).start()
            return
    print('Discord RPC: все варианты активности отклонены')


def _do_rpc_clear():
    """Spotify-style: paused or nothing playing → no presence card at all."""
    global _rpc_last_sent
    with _rpc_lock:
        rpc = _rpc
    if rpc is None:
        return
    if _rpc_last_sent is None:
        return  # nothing is shown — clearing again just burns the budget
    try:
        rpc.clear()
        _rpc_last_sent = None
    except Exception:
        pass


# ── Connection check ─────────────────────────────────────────────────────────
def is_connected():
    try:
        result = subprocess.run(
            ['ping', '-n' if os.name == 'nt' else '-c', '1', 'google.com'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        return result.returncode == 0
    except Exception:
        return False


# ── Windows working-set trim ─────────────────────────────────────────────────
_PROCESS_SET_QUOTA = 0x0100
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_TH32CS_SNAPPROCESS = 0x00000002


class _PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ('dwSize',              ctypes.c_ulong),
        ('cntUsage',            ctypes.c_ulong),
        ('th32ProcessID',       ctypes.c_ulong),
        ('th32DefaultHeapID',   ctypes.c_size_t),
        ('th32ModuleID',        ctypes.c_ulong),
        ('cntThreads',          ctypes.c_ulong),
        ('th32ParentProcessID', ctypes.c_ulong),
        ('pcPriClassBase',      ctypes.c_long),
        ('dwFlags',             ctypes.c_ulong),
        ('szExeFile',           ctypes.c_wchar * 260),
    ]


class _PROCESS_MEMORY_COUNTERS(ctypes.Structure):
    _fields_ = [
        ('cb',                         ctypes.c_ulong),
        ('PageFaultCount',             ctypes.c_ulong),
        ('PeakWorkingSetSize',         ctypes.c_size_t),
        ('WorkingSetSize',             ctypes.c_size_t),
        ('QuotaPeakPagedPoolUsage',    ctypes.c_size_t),
        ('QuotaPagedPoolUsage',        ctypes.c_size_t),
        ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t),
        ('QuotaNonPagedPoolUsage',     ctypes.c_size_t),
        ('PagefileUsage',              ctypes.c_size_t),
        ('PeakPagefileUsage',          ctypes.c_size_t),
    ]


_dlls = None


def _win_dlls():
    global _dlls
    if _dlls is None:
        k32 = ctypes.WinDLL('kernel32', use_last_error=True)
        k32.GetCurrentProcess.restype = ctypes.c_void_p
        k32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
        k32.OpenProcess.restype = ctypes.c_void_p
        # HANDLE args must be declared c_void_p: ctypes defaults to c_int and
        # overflows on 64-bit handle values.
        k32.SetProcessWorkingSetSize.argtypes = (
            ctypes.c_void_p, ctypes.c_size_t, ctypes.c_size_t)
        k32.CloseHandle.argtypes = (ctypes.c_void_p,)
        k32.Process32FirstW.argtypes = (ctypes.c_void_p, ctypes.c_void_p)
        k32.Process32NextW.argtypes = (ctypes.c_void_p, ctypes.c_void_p)
        psapi = ctypes.WinDLL('psapi')
        psapi.GetProcessMemoryInfo.argtypes = (
            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong)
        _dlls = (k32, psapi)
    return _dlls


def _child_webengine_pids():
    """PIDs of our QtWebEngineProcess children (renderer/GPU/utility)."""
    k32, _ = _win_dlls()
    pids = []
    snap = k32.CreateToolhelp32Snapshot(_TH32CS_SNAPPROCESS, 0)
    if not snap or snap == ctypes.c_void_p(-1).value:
        return pids
    try:
        me = os.getpid()
        entry = _PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(_PROCESSENTRY32W)
        ok = k32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            if (entry.th32ParentProcessID == me
                    and 'QtWebEngineProcess' in entry.szExeFile):
                pids.append(entry.th32ProcessID)
            ok = k32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        k32.CloseHandle(snap)
    return pids


def _total_working_set_mb() -> float:
    """Combined working set (what Task Manager shows) of this process plus
    every QtWebEngineProcess child."""
    if os.name != 'nt':
        return 0.0
    try:
        k32, psapi = _win_dlls()
        pmc = _PROCESS_MEMORY_COUNTERS()

        def ws(handle):
            pmc.cb = ctypes.sizeof(pmc)
            if psapi.GetProcessMemoryInfo(handle, ctypes.byref(pmc), pmc.cb):
                return pmc.WorkingSetSize
            return 0

        total = ws(k32.GetCurrentProcess())
        for pid in _child_webengine_pids():
            h = k32.OpenProcess(
                _PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if h:
                total += ws(h)
                k32.CloseHandle(h)
        return total / (1024 * 1024)
    except Exception:
        return 0.0


def _trim_working_sets(include_children: bool):
    """SetProcessWorkingSetSize(-1, -1) on our process and, optionally, every
    QtWebEngineProcess child (renderer/GPU/utility). Windows moves the pages
    to the standby list: RAM usage in Task Manager drops immediately, and on
    restore the pages come back via fast soft-faults — nothing is recomputed
    or lost. include_children=False while music plays, because trimming the
    renderer mid-playback can hiccup the decode pipeline."""
    if os.name != 'nt':
        return
    try:
        k32, _ = _win_dlls()

        def trim(handle):
            k32.SetProcessWorkingSetSize(
                handle, ctypes.c_size_t(-1), ctypes.c_size_t(-1))

        trim(k32.GetCurrentProcess())
        if not include_children:
            return
        for pid in _child_webengine_pids():
            h = k32.OpenProcess(_PROCESS_SET_QUOTA, False, pid)
            if h:
                trim(h)
                k32.CloseHandle(h)
    except Exception:
        pass


# ── AC / battery power state ─────────────────────────────────────────────────
# QtWebEngine doesn't reliably expose navigator.getBattery(), so read the AC
# line status from Windows directly and push it into the page. On battery the
# GPU downclocks and the heavy blur/animation layers throw compositing
# artifacts — the frontend drops to its lite path when told it's unplugged.
class _SYSTEM_POWER_STATUS(ctypes.Structure):
    _fields_ = [
        ('ACLineStatus',        ctypes.c_ubyte),   # 0 = on battery, 1 = plugged, 255 = unknown
        ('BatteryFlag',         ctypes.c_ubyte),
        ('BatteryLifePercent',  ctypes.c_ubyte),
        ('SystemStatusFlag',    ctypes.c_ubyte),
        ('BatteryLifeTime',     ctypes.c_ulong),
        ('BatteryFullLifeTime', ctypes.c_ulong),
    ]


def _ac_is_online():
    """True = plugged in, False = on battery, None = unknown / not Windows."""
    if os.name != 'nt':
        return None
    try:
        status = _SYSTEM_POWER_STATUS()
        if not ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(status)):
            return None
        if status.ACLineStatus == 255:
            return None
        return status.ACLineStatus == 1
    except Exception:
        return None


# ── Qt environment flags ─────────────────────────────────────────────────────
os.environ['QTWEBENGINE_CHROMIUM_FLAGS'] = (
    '--disable-software-rasterizer '
    # NOTE: --disable-accelerated-2d-canvas was removed on purpose: it forced
    # the bass-visualizer canvas onto the CPU, which competed with video
    # decoding while a clip is playing. GPU canvas is Chrome's default.
    '--autoplay-policy=no-user-gesture-required '
    '--ignore-gpu-blocklist '
    # Chromium keeps only the LAST --enable-features/--disable-features flag,
    # so every feature must live in a single comma-separated list.
    '--enable-features=AudioServiceAudioStreams '
    # SpareRendererForSitePerProcess: Chromium pre-warms an idle renderer
    # process "just in case" (~60-100 MB doing nothing). BackForwardCache
    # keeps full snapshots of previous pages in RAM — useless for a
    # single-page app. AudioServiceOutOfProcess spawns a third
    # QtWebEngineProcess on the first sound (WebAudio/visualizer) that never
    # exits afterwards; in-process audio does the same job inside the main
    # process — and is the configuration the app always effectively ran with
    # (the old duplicated --enable-features flag meant it was never active).
    '--disable-features=SpareRendererForSitePerProcess,BackForwardCache,'
    'AudioServiceOutOfProcess '
    # Site isolation puts the YouTube iframe into its own renderer process
    # (~80-150 MB extra). One renderer is enough for our single trusted page.
    '--disable-site-isolation-trials '
    '--renderer-process-limit=1 '
    # NOTE: no --enable-low-end-device-mode here. It saves ~30-50 MB but
    # switches compositor textures to 16-bit color (RGB565/RGBA4444) —
    # visible banding on gradients and degraded font rendering.
    # Cap the V8 JS heap; the player UI + YT embed live in ~30-60 MB.
    '--js-flags=--max-old-space-size=128 '
    '--disk-cache-size=52428800 '
    # Cap the media (audio/video) cache so long viewing sessions don't let it
    # balloon; it's backed by disk, this just keeps it tidy.
    '--media-cache-size=52428800 '
    # Discardable memory backs decoded images and raster tiles. The default
    # budget scales with system RAM (hundreds of MB) and is only purged under
    # system-wide memory pressure — on a machine with free RAM it just grows.
    # 128 MB keeps scrolling smooth; older covers simply re-decode.
    '--force-gpu-mem-discardable-limit-mb=128 '
    '--disable-geolocation '
    '--disable-translate '
    '--disable-sync '
    '--disable-print-preview '
    '--disable-extensions '
    '--disable-component-update '
    '--disable-background-networking '
    '--disable-breakpad'
    # Deliberately ABSENT (previously here, all three are vulnerabilities):
    #   --disable-web-security        — turned off the same-origin policy for
    #                                   every page, including third-party
    #                                   iframes (YT embed).
    #   --allow-running-insecure-content — pointless: the app page is plain
    #                                   http, mixed-content rules never apply.
    #   --ignore-certificate-errors   — accepted ANY https certificate, so all
    #                                   SC/YT traffic was open to MITM.
    # The frontend talks only to the local backend (same origin), so nothing
    # needs these.
)


# ── Bridge (JS ↔ Qt) ─────────────────────────────────────────────────────────
class Bridge(QObject):
    def __init__(self, window):
        super().__init__()
        self.window = window
        self._rpc_thread: threading.Thread | None = None
        self._rpc_pending: str | None = None
        self._rpc_pending_lock = threading.Lock()
        self._rpc_event = threading.Event()

    # ── Window controls ──
    @pyqtSlot()
    def close_app(self):
        self.window.fade_and_close()

    @pyqtSlot()
    def minimize_app(self):
        self.window.fade_and_minimize()

    @pyqtSlot(int, int)
    def move_window(self, x, y):
        self.window.move(x, y)

    @pyqtSlot(result=str)
    def get_pos(self):
        p = self.window.pos()
        return json.dumps({'x': p.x(), 'y': p.y()})

    @pyqtSlot(float)
    def set_zoom_factor(self, factor):
        # Native Chromium zoom — scales layout/fonts/images together without
        # the blurriness or layout quirks a CSS-only zoom can introduce.
        factor = max(0.5, min(2.0, factor))
        self.window.browser.setZoomFactor(factor)

    # ── Discord RPC ──
    @pyqtSlot(str)
    def update_rpc(self, data_json: str):
        """Called from JS with JSON: {title, artist, lyric, cover_url, position, duration, playing}.
        Latest-wins queue served by one long-lived worker. The old skip-if-
        busy approach silently dropped whatever arrived while a slow RPC
        call (or its 8-second reconnect wait) was in flight — Discord then
        showed the previous track until the next play/pause/seek event."""
        with self._rpc_pending_lock:
            self._rpc_pending = data_json
        self._rpc_event.set()
        if self._rpc_thread is None:
            self._rpc_thread = threading.Thread(
                target=self._rpc_worker, daemon=True)
            self._rpc_thread.start()

    def _rpc_worker(self):
        while True:
            self._rpc_event.wait()
            self._rpc_event.clear()
            with self._rpc_pending_lock:
                data = self._rpc_pending
                self._rpc_pending = None
            if data is not None:
                _do_rpc_update(data)
                # Pace the pipe: during this nap the burst a track switch
                # produces (pause → play → durationchange) coalesces into
                # one newest state instead of eating Discord's rate limit.
                time.sleep(1.2)

    @pyqtSlot()
    def clear_rpc(self):
        """Reset RPC to idle state."""
        threading.Thread(target=_do_rpc_clear, daemon=True).start()


# ── Navigation guard ─────────────────────────────────────────────────────────
class SecurePage(QWebEnginePage):
    """The QWebChannel bridge (window controls, Discord RPC) is exposed to
    whatever page the main frame shows, so the main frame may only navigate
    to the local app or the bundled offline page. Any other URL opens in the
    system browser instead. Iframes (YT embed) are unaffected."""

    _ALLOWED_HOSTS = ('127.0.0.1', 'localhost')

    def acceptNavigationRequest(self, url, nav_type, is_main_frame):
        if not is_main_frame:
            return True
        if url.scheme() == 'file' or url.host() in self._ALLOWED_HOSTS:
            return True
        QDesktopServices.openUrl(url)
        return False


# ── Edge resize for the frameless window ─────────────────────────────────────
# FramelessWindowHint gives us no OS resize border, so we carve a thin margin
# out of the central widget (the QWebEngineView is inset by it) and hand any
# drag started inside that margin to the OS via startSystemResize — that's
# what gives native cursors, live outline and Aero edge-snap on Windows.
RESIZE_MARGIN = 3


def _edges_at(pos, rect, margin=RESIZE_MARGIN):
    edges = Qt.Edge(0)
    if pos.x() <= margin:
        edges |= Qt.Edge.LeftEdge
    elif pos.x() >= rect.width() - margin:
        edges |= Qt.Edge.RightEdge
    if pos.y() <= margin:
        edges |= Qt.Edge.TopEdge
    elif pos.y() >= rect.height() - margin:
        edges |= Qt.Edge.BottomEdge
    return edges


def _cursor_for_edges(edges):
    diag1 = (edges & Qt.Edge.LeftEdge and edges & Qt.Edge.TopEdge) or \
            (edges & Qt.Edge.RightEdge and edges & Qt.Edge.BottomEdge)
    diag2 = (edges & Qt.Edge.RightEdge and edges & Qt.Edge.TopEdge) or \
            (edges & Qt.Edge.LeftEdge and edges & Qt.Edge.BottomEdge)
    if diag1:
        return Qt.CursorShape.SizeFDiagCursor
    if diag2:
        return Qt.CursorShape.SizeBDiagCursor
    if edges & Qt.Edge.LeftEdge or edges & Qt.Edge.RightEdge:
        return Qt.CursorShape.SizeHorCursor
    if edges & Qt.Edge.TopEdge or edges & Qt.Edge.BottomEdge:
        return Qt.CursorShape.SizeVerCursor
    return Qt.CursorShape.ArrowCursor


class ResizableCentralWidget(QWidget):
    """Plain background widget that owns the RESIZE_MARGIN border around the
    webview — the only part of the window not covered by the Chromium child
    surface, so it's the only part that can actually receive these events."""

    def __init__(self, window):
        super().__init__()
        self._window = window
        self.setMouseTracking(True)
        # QWidget subclasses ignore stylesheet backgrounds unless this is
        # set — without it the margin fell back to the OS palette (white on
        # the default Windows theme), which is the line that was showing.
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setStyleSheet('background-color: #15110e;')

    def mouseMoveEvent(self, event):
        if not self._window.isMaximized():
            edges = _edges_at(event.position().toPoint(), self.rect())
            self.setCursor(_cursor_for_edges(edges))
        super().mouseMoveEvent(event)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and not self._window.isMaximized():
            edges = _edges_at(event.position().toPoint(), self.rect())
            if edges:
                self._window.windowHandle().startSystemResize(edges)
                return
        super().mousePressEvent(event)


# ── Title bar ────────────────────────────────────────────────────────────────
class TitleBar(QWidget):
    def __init__(self, parent):
        super().__init__(parent)
        self.parent = parent
        self.setFixedHeight(30)
        self.setStyleSheet('background-color: black;')

        layout = QHBoxLayout(self)
        layout.setContentsMargins(5, 0, 5, 0)
        layout.setSpacing(5)

        spacer = QSpacerItem(20, 20, QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Minimum)

        btn_style = """
            QPushButton { background:#333; color:white; border:none; border-radius:3px; font-weight:bold; }
            QPushButton:hover { background:#555; }
        """

        self.minimize_btn = QPushButton('—')
        self.minimize_btn.setFixedSize(20, 20)
        self.minimize_btn.setStyleSheet(btn_style)
        self.minimize_btn.clicked.connect(self.parent.showMinimized)

        self.maximize_btn = QPushButton('□')
        self.maximize_btn.setFixedSize(20, 20)
        self.maximize_btn.setStyleSheet(btn_style)
        self.maximize_btn.clicked.connect(self.toggle_maximize)

        self.close_btn = QPushButton('×')
        self.close_btn.setFixedSize(20, 20)
        self.close_btn.setStyleSheet(
            btn_style.replace('QPushButton:hover { background:#555; }',
                              'QPushButton:hover { background:#FF5555; }')
        )
        self.close_btn.clicked.connect(self.parent.close)

        layout.addItem(spacer)
        layout.addWidget(self.minimize_btn)
        layout.addWidget(self.maximize_btn)
        layout.addWidget(self.close_btn)

    def toggle_maximize(self):
        if self.parent.isMaximized():
            self.parent.showNormal()
        else:
            self.parent.showMaximized()


# ── Main window ───────────────────────────────────────────────────────────────
class Browser(QMainWindow):
    def __init__(self, url):
        super().__init__()

        self._quitting = False
        self._tray_hint_shown = False
        self.setWindowTitle('Steeny Stream')
        self.setGeometry(100, 100, 1354, 868)
        # The page has responsive breakpoints down to roughly this size
        # (sidebar collapses to the icon rail, volume slider hides, player
        # bar tightens); below it text starts truncating too aggressively.
        self.setMinimumSize(620, 460)
        self.app_icon = _application_icon()
        self.setWindowIcon(self.app_icon)

        central_widget = ResizableCentralWidget(self)
        self.setCentralWidget(central_widget)

        main_layout = QVBoxLayout(central_widget)
        main_layout.setContentsMargins(RESIZE_MARGIN, RESIZE_MARGIN, RESIZE_MARGIN, RESIZE_MARGIN)
        main_layout.setSpacing(0)

        self.title_bar = TitleBar(self)
        self.title_bar.setVisible(False)

        self.browser = QWebEngineView()
        main_layout.addWidget(self.browser)

        profile_path = os.path.join(os.getcwd(), 'profile')
        self.profile = QWebEngineProfile('STEENYProfile', self)
        self.profile.setPersistentCookiesPolicy(
            QWebEngineProfile.PersistentCookiesPolicy.ForcePersistentCookies
        )
        self.profile.setCachePath(os.path.join(profile_path, 'cache'))
        self.profile.setPersistentStoragePath(os.path.join(profile_path, 'storage'))
        # QtWebEngine otherwise identifies itself as plain Chrome.  Keep the
        # Chromium-compatible UA for sites that depend on it, while adding a
        # product marker the Steeny backend can use for device sessions.
        self.profile.setHttpUserAgent(
            f'{self.profile.httpUserAgent()} SteenyClient/1.0'
        )
        # Force the HTTP cache to disk (a custom QWebEngineProfile may fall
        # back to an in-memory cache) and cap it so it can't balloon.
        self.profile.setHttpCacheType(QWebEngineProfile.HttpCacheType.DiskHttpCache)
        self.profile.setHttpCacheMaximumSize(50 * 1024 * 1024)

        self.page = SecurePage(self.profile, self.browser)
        self.browser.setPage(self.page)

        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint |
            Qt.WindowType.Window |
            Qt.WindowType.CustomizeWindowHint
        )

        s = self.browser.settings()
        s.setAttribute(QWebEngineSettings.WebAttribute.FullScreenSupportEnabled, True)
        # Must match the --autoplay-policy=no-user-gesture-required Chromium
        # flag above — leaving this True directly contradicts it and blocks
        # any non-click-triggered play() (auto-advance, crossfade, retries)
        # with a DOMException, which is exactly the "YT play error" seen in
        # the console on track auto-advance.
        s.setAttribute(QWebEngineSettings.WebAttribute.PlaybackRequiresUserGesture, False)
        s.setAttribute(QWebEngineSettings.WebAttribute.PluginsEnabled, False)
        s.setAttribute(QWebEngineSettings.WebAttribute.JavascriptCanOpenWindows, False)
        s.setAttribute(QWebEngineSettings.WebAttribute.LocalStorageEnabled, True)
        s.setAttribute(QWebEngineSettings.WebAttribute.XSSAuditingEnabled, False)
        s.setAttribute(QWebEngineSettings.WebAttribute.ErrorPageEnabled, False)
        # The UI only uses 2D canvas (bass visualizer) and <video>/<audio> —
        # no WebGL anywhere. Disabling it frees GPU-process and renderer
        # memory reserved for GL contexts.
        s.setAttribute(QWebEngineSettings.WebAttribute.WebGLEnabled, False)
        s.setAttribute(QWebEngineSettings.WebAttribute.DnsPrefetchEnabled, False)

        self.channel = QWebChannel()
        self.bridge = Bridge(self)
        self.channel.registerObject('bridge', self.bridge)
        self.browser.page().setWebChannel(self.channel)

        # Chromium reveals the audio OUTPUT device list only to pages holding
        # microphone permission; the settings page requests it once to fill
        # the output-device selector. Grant silently — but only audio capture
        # and only for the local app. Qt 6.8+ uses permissionRequested; older
        # versions use featurePermissionRequested.
        if hasattr(self.page, 'permissionRequested'):
            self.page.permissionRequested.connect(self._on_permission)
        elif hasattr(self.page, 'featurePermissionRequested'):
            self.page.featurePermissionRequested.connect(
                self._on_feature_permission)

        self.browser.loadFinished.connect(self._disable_zoom)
        self.browser.loadFinished.connect(self._push_power_state)
        self.browser.load(QUrl(url))

        # Poll AC/battery state and tell the page when it changes, so it can
        # switch to the lite render path on battery (fixes GPU artifacts).
        self._last_ac = None
        self._power_timer = QTimer(self)
        self._power_timer.setInterval(5_000)
        self._power_timer.timeout.connect(self._poll_power)
        self._power_timer.start()

        # Memory watchdog: long sessions pile renderer caches (decoded
        # covers, raster tiles, media buffers) into the gigabytes — Chromium
        # only drops them under system-wide memory pressure, which a machine
        # with free RAM never signals. Check once a minute and trim when the
        # combined working set crosses the limit.
        self._mem_timer = QTimer(self)
        self._mem_timer.setInterval(60_000)
        self._mem_timer.timeout.connect(self._memory_watchdog)
        self._mem_timer.start()

        self._setup_tray()
        self.old_pos = None

    def _setup_tray(self):
        self.tray = None
        if not QSystemTrayIcon.isSystemTrayAvailable():
            return

        self.tray = QSystemTrayIcon(self.app_icon, self)
        self.tray.setToolTip('STEENY — музыкальный плеер')

        menu = QMenu(self)
        self.tray_open_action = QAction('Открыть STEENY', self)
        self.tray_open_action.triggered.connect(self.show_from_tray)
        menu.addAction(self.tray_open_action)

        self.tray_hide_action = QAction('Скрыть в трей', self)
        self.tray_hide_action.triggered.connect(self.hide_to_tray)
        menu.addAction(self.tray_hide_action)

        menu.addSeparator()
        self.tray_quit_action = QAction('Выйти из STEENY', self)
        self.tray_quit_action.triggered.connect(self.quit_from_tray)
        menu.addAction(self.tray_quit_action)

        menu.setDefaultAction(self.tray_open_action)
        self.tray.setContextMenu(menu)
        self.tray.activated.connect(self._tray_activated)
        self.tray.show()
        self._sync_tray_actions()

    def _sync_tray_actions(self):
        if self.tray is None:
            return
        visible = self.isVisible() and not self.isMinimized()
        self.tray_open_action.setEnabled(not visible)
        self.tray_hide_action.setEnabled(visible)

    def _tray_activated(self, reason):
        if reason == QSystemTrayIcon.ActivationReason.DoubleClick:
            self.show_from_tray()
        elif reason == QSystemTrayIcon.ActivationReason.Trigger:
            if self.isVisible() and not self.isMinimized():
                self.hide_to_tray()
            else:
                self.show_from_tray()

    def show_from_tray(self):
        self.setWindowOpacity(1.0)
        if self.isMinimized():
            self.showNormal()
        else:
            self.show()
        self.raise_()
        self.activateWindow()
        self._sync_tray_actions()

    def hide_to_tray(self):
        if self.tray is None or not self.tray.isVisible():
            self.quit_from_tray()
            return
        self.hide()
        self.setWindowOpacity(1.0)
        self._sync_tray_actions()
        if not self._tray_hint_shown and self.tray.supportsMessages():
            self._tray_hint_shown = True
            self.tray.showMessage(
                'STEENY работает в фоне',
                'Откройте программу через значок в системном трее.',
                QSystemTrayIcon.MessageIcon.Information,
                3500,
            )

    def quit_from_tray(self):
        self._quitting = True
        try:
            _do_rpc_clear()
        except Exception:
            pass
        if self.tray is not None:
            self.tray.hide()
        self.close()
        QApplication.instance().quit()

    def closeEvent(self, event):
        if not self._quitting and self.tray is not None and self.tray.isVisible():
            event.ignore()
            self.hide_to_tray()
            return
        event.accept()

    def showEvent(self, event):
        super().showEvent(event)
        self._sync_tray_actions()

    # Above the soft limit the working set is handed back to the OS. While
    # audio is playing the higher limit applies: trimming the renderer mid-
    # playback risks a brief hiccup, so it's reserved for real runaways.
    _MEM_SOFT_LIMIT_MB = 800
    _MEM_AUDIBLE_LIMIT_MB = 1300

    def _memory_watchdog(self):
        # recentlyAudible() must run on the Qt main thread; the measuring and
        # trimming (WinAPI calls on other processes) go to a worker thread.
        limit = (self._MEM_AUDIBLE_LIMIT_MB if self.page.recentlyAudible()
                 else self._MEM_SOFT_LIMIT_MB)

        def check():
            if _total_working_set_mb() > limit:
                _trim_working_sets(include_children=True)

        threading.Thread(target=check, daemon=True).start()

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.old_pos = event.globalPosition().toPoint() - self.frameGeometry().topLeft()

    def mouseMoveEvent(self, event):
        if self.old_pos is not None and event.buttons() == Qt.MouseButton.LeftButton:
            self.move(event.globalPosition().toPoint() - self.old_pos)

    def mouseReleaseEvent(self, event):
        self.old_pos = None

    def wheelEvent(self, event):
        if event.modifiers() == Qt.KeyboardModifier.ControlModifier:
            event.ignore()
        else:
            super().wheelEvent(event)

    def changeEvent(self, event):
        if event.type() == QEvent.Type.WindowStateChange:
            if self.isMinimized():
                self.browser.hide()
                # Freeze the page while minimized — Chromium suspends timers,
                # rAF loops and drops renderer caches (memory-pressure signal).
                # Only when nothing is playing: freezing would stop the audio
                # pipeline, and background playback must keep working.
                if not self.page.recentlyAudible():
                    try:
                        self.page.setLifecycleState(
                            QWebEnginePage.LifecycleState.Frozen)
                    except Exception:
                        pass
                # Give the freeze a moment to run Chromium's own purge, then
                # hand whatever is left back to the OS.
                QTimer.singleShot(2000, self._trim_after_minimize)
            else:
                self.browser.show()
                try:
                    self.page.setLifecycleState(
                        QWebEnginePage.LifecycleState.Active)
                except Exception:
                    pass
            self._sync_tray_actions()
        super().changeEvent(event)

    @staticmethod
    def _is_local_origin(origin) -> bool:
        return origin.host() in ('127.0.0.1', 'localhost') or origin.scheme() == 'file'

    def _on_permission(self, permission):  # Qt 6.8+
        from PyQt6.QtWebEngineCore import QWebEnginePermission
        if (self._is_local_origin(permission.origin()) and
                permission.permissionType() ==
                QWebEnginePermission.PermissionType.MediaAudioCapture):
            permission.grant()
        else:
            permission.deny()

    def _on_feature_permission(self, origin, feature):  # Qt < 6.8
        grant = (self._is_local_origin(origin) and
                 feature == QWebEnginePage.Feature.MediaAudioCapture)
        self.page.setFeaturePermission(
            origin, feature,
            QWebEnginePage.PermissionPolicy.PermissionGrantedByUser if grant
            else QWebEnginePage.PermissionPolicy.PermissionDeniedByUser)

    def _trim_after_minimize(self):
        # User may have restored the window during the 2 s delay.
        if not self.isMinimized():
            return
        include_children = not self.page.recentlyAudible()
        threading.Thread(
            target=_trim_working_sets, args=(include_children,), daemon=True
        ).start()

    def _poll_power(self, force=False):
        ac = _ac_is_online()
        if ac is None:
            return  # unknown / desktop without a battery — leave full quality
        if not force and ac == self._last_ac:
            return
        self._last_ac = ac
        # charging=True means plugged in → no power saving
        js = ('window.__steenySetCharging && window.__steenySetCharging(%s);'
              % ('true' if ac else 'false'))
        try:
            self.browser.page().runJavaScript(js)
        except Exception:
            pass

    def _push_power_state(self, ok=True):
        # Re-send the current state once the page has loaded its JS hook.
        if ok:
            self._poll_power(force=True)

    def _disable_zoom(self):
        self.browser.page().runJavaScript("""
            document.addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
            document.addEventListener('keydown', e => {
                if (e.ctrlKey && (e.key==='+' || e.key==='-' || e.key==='0' ||
                    e.keyCode===107 || e.keyCode===109 || e.keyCode===48)) e.preventDefault();
            });
        """)

    def fade_and_close(self):
        if self.tray is None or not self.tray.isVisible():
            self.quit_from_tray()
            return
        self.animation = QPropertyAnimation(self, b'windowOpacity')
        self.animation.setDuration(300)
        self.animation.setStartValue(1.0)
        self.animation.setEndValue(0.0)
        self.animation.setEasingCurve(QEasingCurve.Type.InOutQuad)
        self.animation.finished.connect(self.hide_to_tray)
        self.animation.start()

    def fade_and_minimize(self):
        self.animation = QPropertyAnimation(self, b'windowOpacity')
        self.animation.setDuration(300)
        self.animation.setStartValue(1.0)
        self.animation.setEndValue(0.0)
        self.animation.setEasingCurve(QEasingCurve.Type.InOutQuad)

        def _finish():
            self.showMinimized()
            self.setWindowOpacity(1.0)

        self.animation.finished.connect(_finish)
        self.animation.start()


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == '__main__':
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    app.setApplicationDisplayName('STEENY')
    app.setOrganizationName('Ivan0n co.')
    app.setWindowIcon(_application_icon())

    url = 'http://127.0.0.1:5000' if is_connected() else \
          QUrl.fromLocalFile(os.path.abspath('ofline.html')).toString()

    window = Browser(url)
    window.show()

    # Connect to Discord in background — non-blocking
    threading.Thread(target=_rpc_init, daemon=True).start()

    sys.exit(app.exec())
