# Wildwood

Your survival game as a regular Expo project.

## One-time setup
1. Install **Node.js LTS** from https://nodejs.org (the big green "LTS" button).
2. Unzip this folder somewhere easy, like your Documents folder.
3. Open a terminal in the `wildwood` folder:
   - **Windows:** open the folder in File Explorer, click the address bar, type `cmd`, press Enter.
   - **Mac:** right-click the folder in Finder → *New Terminal at Folder*.
4. Run:
   ```
   npm install
   ```
   (takes a minute or two, only needed once)

## Every time you want to play / test
```
npx expo start
```
- **Phone:** install **Expo Go** from the App Store / Google Play, make sure the phone is on the same Wi-Fi as the computer, then scan the QR code in the terminal (iPhone: use the Camera app).
- **Browser:** press `w` in the terminal.
- After you change App.js, the game reloads on its own. Press `r` in the terminal to force a reload.
- Stop it with `Ctrl + C`.

## Where things go
- `App.js` — the whole game (same file you've been pasting into Snack).
- `assets/` — images, and later 3D models (.glb files) and sounds.
