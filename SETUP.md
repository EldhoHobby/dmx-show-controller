# Setting up a new computer

How to install the DMX Show Controller on a Windows computer that you use both to run shows
and to keep developing the program. It takes about 30 minutes.

The computer gets **two copies** of the program:

| Folder | What it is for |
|---|---|
| `C:\DMX\show` | The copy you run at events. It changes only when you decide to update it. |
| `C:\DMX\dev` | The copy for development. Unfinished work here never touches your shows. |

Your shows, songs and output settings live inside each copy (in its `shows`, `media` and
`config` folders), never on GitHub.

## 1. Install the tools

1. **Node.js** (runs the engine): go to <https://nodejs.org>, download the **LTS** version for
   Windows (the `.msi` installer) and install it with the default settings.
2. **Git** (downloads and updates the program): go to <https://git-scm.com/download/win>,
   download **Git for Windows** and install it with the default settings. It includes the
   GitHub sign-in helper.
3. **For development:** install the Claude desktop app from <https://claude.ai/download> and sign
   in. Its Code tab is where the program is developed.

Check that the first two worked: press the Windows key, type `cmd`, press Enter, and type:

```bat
node --version
```

It should print `v22` or higher (for example `v24.12.0`). Then:

```bat
git --version
```

## 2. Download the program (both copies)

In the same Command Prompt window, type these lines one at a time:

```bat
mkdir C:\DMX
cd C:\DMX
git clone https://github.com/EldhoHobby/dmx-show-controller.git show
git clone https://github.com/EldhoHobby/dmx-show-controller.git dev
```

The first `git clone` opens a GitHub sign-in window (the repository is private): sign in as
**EldhoHobby**. The second one remembers it.

Keep `C:\DMX` out of OneDrive and other synced folders: syncing slows the show's saves down and
can break git's files.

## 3. Bring your shows and songs

From the old computer's **move kit** (the `move-kit` folder, copied over on a USB stick or
through OneDrive), unzip `DMX-data.zip` and copy its two folders into `C:\DMX\show`:

- `shows` holds your current show (it opens by itself when the engine starts) and the demo show
- `media` holds the songs the app had already loaded, so you do not have to load them again

Copy them into `C:\DMX\dev` too if you want the same shows while developing.

Do not copy the old `config` folder: the output settings belong to the old computer's network
adapter. You set them up fresh in step 5.

## 4. First start

1. Double-click `C:\DMX\show\start-network.bat` (or `start.bat` if you do not need phones and
   tablets).
2. Windows may ask whether Node.js may use the network: allow it on **Private** networks.
   Without this, no DMX leaves the computer.
3. The black engine window should say **DMX Show Controller 0.3.4** (or newer) and **Running at
   high priority**. The app opens in your browser. Use Chrome or Edge.

Leave the engine window open while you work. Closing it stops the lights.

## 5. Connect the lights

1. Connect the DMX node (for example the Chauvet DMX-AN2) to the computer **with a network
   cable**. Wi-Fi delays and drops lighting data on many routers.
2. In the app, go to **Edit › Outputs**. Under sACN or Art-Net, pick the network adapter that the
   cable is plugged into, and the universes your lights use. (A DMX-AN2 out of the box expects
   the 2.x.x.x network; see Troubleshooting in the README.)
3. Check on **Edit › Control** that a fader moves the right light.
4. On the **Song** page, set **Light offset** if the lights look early or late against your
   speakers. It belongs to this computer, so it starts at 0 here.

## 6. Make it a reliable show computer

- **Power:** Settings › System › Power: when plugged in, never turn off the screen or sleep, and
  pick **Best performance**.
- **Updates:** Settings › Windows Update: set **active hours** to cover your events, so the
  computer never restarts in the middle of a show.
- **During a show:** close programs you do not need (Adobe Creative Cloud, cloud sync, games) and
  keep **one** window with the 3D view open. On a busy computer the lights can stutter: look at
  **Live › Output**, where the engine should show close to 40 fps.
- **Before every event:** start the program, play the first song for a minute, and check the
  lights react. Keep a USB stick with your songs.

## 7. Everyday use

**Running a show:** always start `C:\DMX\show\start-network.bat` (or `start.bat`).

**Developing:** open the `C:\DMX\dev` folder in the Claude desktop app's Code tab. To try the dev
copy while the show copy is running, start it on another port:

```bat
cd C:\DMX\dev
start.bat --port 8081
```

and open <http://localhost:8081> yourself. `start.bat` always opens a browser tab on
<http://localhost:8080> whatever port you give it, so on a machine where the show copy is
running, that tab is the **show** copy, not the dev one. Close it and use the 8081 address.

Development work goes on its own git branch and reaches GitHub when you ask for it to be
pushed.

**Updating the show copy** (after a new version has been tested and merged into `main`):

1. Close the show copy's engine window.
2. Double-click `C:\DMX\show\update.bat`. It downloads the latest version and tells you which
   one you have. Your shows, songs and output settings are not touched.
3. Start it again and check the version in the engine window.

Do not update right before an event. If a new version misbehaves, go back to the previous
one. Each version has a tag; `git tag` lists them, and the one below `v0.3.4` is `v0.3.3`:

```bat
cd C:\DMX\show
git tag
git checkout v0.3.3
```

`update.bat` brings you back to the latest version later.

## Troubleshooting the setup

- **"Node.js was not found"** when starting: install Node.js (step 1), then close and reopen
  the Command Prompt or double-click again.
- **`git clone` asks for a password:** sign in through the window that opens; do not type a
  password into the Command Prompt. If no window opens, install Git for Windows again with the
  default settings.
- **"The DMX Show Controller is already running on this computer":** the other copy (show or
  dev) is up. Close its engine window, or start this one with `--port 8081`.
- **"Another program is using port 8080"** (or **"Port 8080 is already in use"**): something
  that is not this program has the port. Start with `--port 8081` and open that address.
- **The app opens but the lights do nothing:** see step 5, and Troubleshooting in `README.md`.
