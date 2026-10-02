# DMX Show Controller

Browser-based lighting show designer and player. Load a song, let the app find its tempo, beats,
sections and drops, generate a light show for your actual rig, refine it on a timeline, export
one small file, and play it at the event over sACN, Art-Net or a USB DMX interface. At the event
you can also take any fixture by hand, fire recorded scenes, and let a microphone or line-in drive
the lights live.

- Zero dependencies: Node.js runs the engine, any modern browser is the interface.
- Works offline at the venue: nothing is loaded from the internet.
- Built for the Chauvet DJ DMX-AN2 (sACN), but works with any sACN or Art-Net node.

## Start it

**Windows:** double-click `start.bat`. It finds Node.js (installed, or the copy that ships with
Visual Studio), starts the engine and opens the app in your browser.

**Any system:** install Node.js 20 or newer, then:

```bash
node server/index.js
```

and open <http://localhost:8080> in Chrome, Edge or Firefox. For the Song page's demo track, run
`node tools/make-demo-audio.js` once first (`start.bat` does this for you). Safari works for everything except
USB DMX, which needs Chrome, Edge or Firefox 151+ in a window on the show computer itself
(browsers only allow serial ports on secure pages, and `localhost` counts as secure).

### From a phone or tablet

By default only this computer can open the app. For phones and tablets, double-click
**`start-network.bat`** instead (or run `node server/index.js --host 0.0.0.0`). The engine window
prints the address to open, for example `http://192.168.1.20:8080`. Type it into the phone's
browser while the phone is on the same Wi-Fi. A phone opens in Live mode and works as a remote: it
does not play the song unless you tick *Play song here*.

- Windows asks once whether Node.js may use the network. Allow it for the kind of network you are
  on (Private or Public); Settings › Network shows which one your Wi-Fi is.
- Anyone on that network can control the lights, so use a network you trust.
- Guest Wi-Fi often blocks devices from reaching each other; use the main network.
- Only one engine can run at a time; a second copy refuses to start.

## Workflow

The app has two modes: **Edit** (build the show) and **Live** (run it).

| Step | Where | What you do |
| --- | --- | --- |
| 1 | Edit › Patch | Add fixtures and give them DMX addresses. Drag them into place on the **stage layout** (top, front and side views; drag the dot on a beam line to aim a fixture), or drag them to new addresses on the **DMX address grid**. Similar fixtures are **grouped automatically**. Import exact fixture files from [Open Fixture Library](https://open-fixture-library.org) (download as *OFL JSON*). |
| 2 | Edit › Calibrate | Moving heads only. Set the **centre point**, **Prime** all heads onto it, and nudge each one until its beam lands on the mark. The offsets are saved and applied to every cue and generated design. |
| 3 | Edit › Song | Drop in an MP3/WAV/AAC/FLAC. The app detects BPM, beats, bars, sections and drops. Correct the grid if needed (Tap, ×2/÷2, nudge, bar start), fix section labels, then **Generate show**. |
| 4 | Edit › Timeline | Edit the generated clips: move, resize, copy, change effects, keyframes. Everything snaps to the beat. |
| 5 | Edit › Control | **Group faders** (intensity, colour, pan, tilt, zoom, strobe, gobo) and, for one fixture, a pan/tilt pad plus a fader for **every DMX channel** with the value going out right now. Record what the faders hold as **scenes**. |
| 6 | Edit › Outputs | Choose sACN / Art-Net / USB and the network adapter. One click sets up a DMX-AN2. |
| 7 | Export | Validates the show (address clashes, out-of-range moves, missing profiles, stale scenes…) and saves a self-contained `.dmxshow.json`. |
| 8 | Live | Open the file, press Play. Grand master, blackout, hold-to-flash blinder and strobe, ±50 ms nudge, **scene buttons**, and **live audio** that makes the lights react to the music in the room. |

Try it without your own rig or music: the Song page has a **demo track** button, and
`shows/Demo show (128 BPM).dmxshow.json` is a ready-made, validated example.

Keys: **Space** play/pause · **Ctrl+Z / Ctrl+Y** undo/redo · **Delete**, **Ctrl+D**, **←/→**
on selected clips · stage layout: **arrows** nudge the selection 10 cm (Shift 50 cm) ·
Calibrate: **arrows** move the beam's spot (Shift for bigger steps) · Live mode: **B** blackout,
hold **F** blinder, hold **S** strobe, **←/→** nudge.

## Manual control, scenes and calibration

- **What wins.** The show plays underneath; scenes fade in on top of it; faders on the Control
  page (the "programmer") override both until you release them. A fader sets intensity exactly
  (it can also take a light *down*). Blackout and the grand master always apply, including to
  values set on raw DMX channels. Faders that you are not holding follow the show, so they always
  show what the lights are doing.
- **Release.** Every held fader has a × button; each group and fixture has *Release*; the top
  bar shows a **Manual** chip whenever anything is held: click it to hand everything back to the
  show. A **Calibrating** chip does the same for calibration, so neither can be forgotten.
- **Scenes** store fixture attributes and raw channel values with a fade time. Tap a scene button
  in Live mode to fade it in, tap again to fade it out. They are saved in the show file.
- **Calibration** moves the spot in stage terms: ◀ ▶ are left/right as the audience sees it, ▲ ▼
  further/closer on the floor (or up/down when the centre point is at head height), however the
  head is hung. The app works out the pan/tilt change from the fixture's position and mounting.

## Live audio input

Live mode has a **Live audio** card. Pick the input (a line-in from the DJ mixer is far better
than a microphone), press **Listen**, then turn on **Lights react**. By default the kick pulses
the colour washes, the snare/vocal band steps their colour, and hi-hats flick the moving heads;
change this under *Reactions and sensitivity* (pulse, flash, strobe, step colour, follow the
level, or bring in a scene, for any group).

- It runs in the window **on the controller computer** (`http://localhost:8080`): browsers only
  open audio inputs on `localhost` or HTTPS. Phones see the meters but cannot be the input.
- Only one window can be the input at a time.
- Turn off "audio enhancements" / noise suppression for the input in Windows sound settings; the
  app already asks the browser for an unprocessed signal.
- Measured delays: a hit is detected 2–6 ms after it starts (kick 5.3 ms, snare 2.7 ms, hi-hat
  2.0 ms, including the 2.7 ms audio block), and the engine puts it on the network about 1 ms
  later. Add the sound card's input delay (about 10 ms) and the DMX line itself (up to 23 ms per
  refresh): the light follows the sound by about 15–40 ms, which is less than sound takes to
  travel 10 m across a room.

How it works, for developers: `shared/analysis/live-detector.js` (band filters, onset rules,
tempo) runs in an AudioWorklet on the browser's real-time audio thread; hits go through a
MessagePort to a worker with its own WebSocket, and the engine sends a DMX frame the moment a
hit arrives instead of waiting for its next 25 ms tick. The page's UI thread is never on that
path. The full algorithm notes are in the build brief.

## Design decisions (changes from the original specification)

The specification asked for a "fully web-browser-based" controller. These are the points where
I changed or tightened it, and why.

1. **A small local engine plus browser windows, not a pure web page.** Browsers cannot send
   UDP, so a web page alone can never output sACN or Art-Net. The engine (`server/`) is a
   ~1,400-line Node.js process with no dependencies. It owns the show, the clock and the DMX
   output. Every browser window is a client. This is also what delivers the "multiple
   simultaneous web clients" requirement: all windows edit and watch the same show live.

2. **The show clock lives in the engine, not in a browser tab.** Chrome throttles timers in
   background tabs, so a browser-driven show stutters the moment the operator switches
   windows. On Windows I measured Node's timers firing on a 15.6 ms OS tick, so a naive 40 Hz
   loop really runs at about 32 Hz. The engine schedules frames on an ideal grid and computes
   each frame from the real clock, so the lights are always exactly where the music is.
   Measured: 40.5 frames/s, about 0.5 ms of work per frame.

3. **USB via Web Serial and Enttec DMX USB Pro, not WebUSB.** On Windows, WebUSB only reaches
   devices on the generic WinUSB driver, and it cannot use an interface another driver has
   claimed, so it cannot drive an FTDI-based interface with its normal driver installed. Web
   Serial works with the normal driver (Chrome, Edge, Firefox 151+). Enttec Pro-compatible
   interfaces time DMX themselves. Cheap "Open DMX" cables need microsecond break timing that no
   browser can guarantee, so they are not supported.

4. **Auto-sequencing is a rules engine, and you should expect to edit its output.** It maps
   each detected section (intro, groove, build, drop, breakdown, outro) to looks, beat chases,
   movement and colour effects, scaled by energy, laid out across the real stage positions. It
   produces a strong first draft. It is not machine learning and has no taste.

5. **The audio analysis is verified on synthetic tracks; real recordings will be messier.**
   On generated club tracks at 100, 128 and 174 BPM it finds the exact tempo, beats within
   15 ms, the correct bar starts and every section boundary (see `test/analysis.test.js`).
   Real recordings with tempo changes, breakdowns without drums or unusual structures will need
   the correction tools on the Song page.

6. **The event file is self-contained.** Besides millisecond timings and clips, it embeds every
   fixture profile the patch uses and the beat grid. It opens on any machine, and tempo-following
   can be added later. It never contains the audio. The song is cached on the show computer by
   content hash, and a reload restores it automatically.

7. **Plain WebGL instead of Three.js** for the 3D view, so the visualizer works with no internet
   at the venue. The 3D view runs the same evaluation code as the DMX engine, so what you see is
   what is sent. Open it in its own window for a second screen.

8. **Live audio runs on the browser's real-time audio thread, not in a native add-on.** The
   specification asked for a native thread outside the browser UI loop. An AudioWorklet is
   exactly that: the browser's own real-time audio thread, separate from the page. Detection runs
   there in 128-sample blocks, a worker forwards hits on its own socket, and the engine fires an
   extra DMX frame per hit. This keeps the app free of compiled dependencies (nothing to build
   per Windows version) and still measures 2–6 ms detection plus about 1 ms to the network. A
   native capture module would only be worth it for multi-channel audio interfaces.

9. **Hits are triggers, not velocities.** A hit is reported the moment it starts, before the
   sound has peaked, so its loudness is not known yet. Every hit therefore fires at full
   strength; loudness reaches the lights through the *Follow the level* reaction instead.

10. **Security defaults.** The engine is localhost-only unless started with `--host 0.0.0.0`.
   It rejects WebSocket connections from other websites (origin check), so a malicious page in
   the operator's browser cannot take over the lights. Audio uploads are verified against their
   hash. All show data from files or the network is rebuilt from known fields before use.

## Open questions for the next phase

- **Staying in sync with the DJ.** The spec has no sync mechanism. Today you either let this app
  play the song, or press Play when the DJ starts the track and correct with the ±50 ms nudge.
  If the DJ changes tempo (pitch fader) a fixed timeline drifts. The fix is to follow an
  external clock: Ableton Link, MIDI clock/timecode, or Pioneer Pro DJ Link from CDJs. Which
  DJ setup will you use?
- Pixel bars and other multi-cell fixtures (patch the cells as separate fixtures for now).
- Visual rendering of gobos and prisms in the 3D view (the DMX output already supports them).
- Packaging as a desktop app or installer, if Node.js should be hidden from the operator.

## Project layout

```
server/        engine: HTTP + WebSocket server, session, frame loop, sACN / Art-Net output
shared/        code that runs in both the engine and the browser:
                 show model, edit operations (undo), timeline evaluation, DMX rendering,
                 validation, beat grid, fixture library, OFL import, audio analysis, generator
client/        the browser app (no build step): views, WebGL visualizer, audio, Web Serial USB
test/          node:test suites, including an end-to-end test of the real engine
tools/         demo track generator
shows/         autosave and exported shows        media/   cached song audio
config/        outputs.json: venue output settings (per machine)
```

Run the tests (about 20 seconds; they include the real engine end to end and the live-audio
hit-to-network delay):

```bash
node --test "test/**/*.test.js"
```

## Troubleshooting

- **Lights do not react with a DMX-AN2:** the computer's Ethernet adapter must be on the node's
  network (2.0.0.2 / 255.0.0.0 out of the box). On Edit › Outputs pick that adapter, because
  multicast otherwise follows the default route, which is usually Wi-Fi.
- **"Port 8080 is already in use":** the engine is already running in another window, or start it
  with `--port 8081`.
- **A light ignores the timeline:** check the top bar for a **Manual** chip (faders are holding
  it) or a **Calibrating** chip. Click the chip to give the lights back to the show.
- **No Listen button on a phone:** live audio has to be started in the window on the controller
  computer (see Live audio input).
- **Windows firewall prompt:** Windows may ask whether Node.js may use the network the first time
  the engine sends DMX. Allow it on private networks, or no DMX leaves the computer.
