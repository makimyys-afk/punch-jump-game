// ============================================================
// Punch Jump! — Doodle Jump reskin featuring Punch-kun
// Complete rewrite: proper physics, tight hitboxes, difficulty scaling
// Fixed: deltaTime-based game loop, background music, volume control
// ============================================================

// --- Play.fun SDK (Hybrid Integration) ---
// Client SDK handles auth/UI, Server SDK handles point submission
const SERVER_URL = 'https://punch-jump-server.vercel.app';

let ogp = null;
let sdkReady = false;
let pointsSentThisRound = 0;
let lastPointsSent = 0;
const POINTS_SEND_INTERVAL = 50;

function initPlayFunSDK() {
    try {
        if (typeof OpenGameSDK !== 'undefined') {
            ogp = new OpenGameSDK({ ui: { usePointsWidget: true, theme: 'light' } });
            ogp.init({ gameId: '191135f4-298e-4ed0-8046-85ab90922974' });
            ogp.on('OnReady', () => { sdkReady = true; console.log('[Play.fun] SDK ready'); });
        }
    } catch (err) { console.warn('[Play.fun] SDK init error:', err); }
}

function sendPointsToSDK(points) {
    // Client SDK: addPoints for live widget display only
    if (ogp && sdkReady && points > 0) {
        try { ogp.addPoints(points); pointsSentThisRound += points; }
        catch (err) { console.warn('[Play.fun] addPoints error:', err); }
    }
}

async function endGameSDK(finalScore) {
    // Hybrid: submit final score via server for Game Integrity
    try {
        let sessionToken = null;
        let playerId = null;

        if (ogp && sdkReady) {
            // Try to get session token
            try { sessionToken = await ogp.sessionToken(); } catch(e) {}
            // Try to get player/user info for playerId
            try {
                const user = await ogp.user();
                if (user) {
                    // Prefer ogpId, then solana wallet, then privy id
                    playerId = user.ogpId || user.id ||
                        (user.wallet?.address ? 'sol:' + user.wallet.address : null) ||
                        (user.privyId ? user.privyId : null);
                }
            } catch(e) {}
        }

        // Submit to server if we have a player identifier
        if ((sessionToken || playerId) && finalScore > 0) {
            try {
                const resp = await fetch(SERVER_URL + '/api/submit-points', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionToken, playerId, points: finalScore }),
                });
                const data = await resp.json();
                if (data.success) {
                    console.log('[Play.fun] Server saved', data.savedCount, 'points');
                } else {
                    console.warn('[Play.fun] Server error:', data.error);
                }
            } catch(fetchErr) {
                console.warn('[Play.fun] Server fetch error:', fetchErr);
            }
        }

        // Client SDK endGame for UI modal
        if (ogp && sdkReady && pointsSentThisRound > 0) {
            try { await ogp.endGame(); } catch (err) { console.warn('[Play.fun] endGame error:', err); }
        }
    } catch (err) {
        console.warn('[Play.fun] endGameSDK error:', err);
        // Fallback: client-only endGame
        if (ogp && sdkReady && pointsSentThisRound > 0) {
            try { await ogp.endGame(); } catch(e) {}
        }
    }
}

// --- Board ---
let board;
const boardWidth = 360;
const boardHeight = 576;
let context;

// --- Punch (player character) ---
const punchWidth = 80;
const punchHeight = 80;
const punchX = boardWidth / 2 - punchWidth / 2;
const punchY = boardHeight * 7 / 8 - punchHeight;

// Sprite images
let punchRightImg, punchLeftImg, punchJumpImg, punchFallImg;
let punchSadImg, punchHappyImg, punchIdleImg;

let punch = {
    img: null,
    x: punchX,
    y: punchY,
    width: punchWidth,
    height: punchHeight
};

// --- Physics (tuned for snappy, responsive feel) ---
// All physics values are calibrated for 60 FPS (16.67ms per frame)
let velocityX = 0;
let velocityY = 0;
const initialVelocityY = -12;   // strong jump impulse (max height ~160px)
const gravity = 0.5;             // snappy gravity for responsive feel
const moveSpeed = 5;             // horizontal movement speed
const TARGET_FPS = 60;
const TARGET_FRAME_TIME = 1000 / TARGET_FPS; // 16.67ms

// --- DeltaTime ---
let lastFrameTime = 0;

// --- Platforms ---
let platformArray = [];
const platformWidth = 60;
const platformHeight = 18;
let platformImg;

// Platform spacing — controls difficulty
const BASE_GAP_MIN = 85;
const BASE_GAP_MAX = 115;
const MAX_GAP_MIN = 105;
const MAX_GAP_MAX = 140;
const DIFFICULTY_SCORE = 3000;

// Number of platforms on screen
const INITIAL_PLATFORM_COUNT = 5;

// --- Game State ---
let score = 0;
let maxScore = 0;
let gameOver = false;
let gameStarted = false;
let highScore = parseInt(localStorage.getItem('punchJumpHighScore')) || 0;

// --- Happy flash effect on landing ---
let happyFlashTimer = 0;

// --- Bounce lock: prevents double-bounce in same fall ---
let bouncedThisFall = false;

// --- UI Elements ---
let gameOverOverlay, finalScoreEl, restartBtn;

// --- Touch Controls ---
let touchStartX = null;
let touchCurrentX = null;
let isTouching = false;

// --- Background Music & Volume ---
let bgMusic = null;
let volumeBtn = null;
let volumeSlider = null;
let isMuted = false;
let currentVolume = 0.5;
let musicStarted = false;

// ============================================================
// INIT
// ============================================================
window.onload = function () {
    board = document.getElementById('board');
    board.height = boardHeight;
    board.width = boardWidth;
    context = board.getContext('2d');

    gameOverOverlay = document.getElementById('game-over-overlay');
    finalScoreEl = document.getElementById('final-score');
    restartBtn = document.getElementById('restart-btn');

    // Load sprites
    punchRightImg = new Image(); punchRightImg.src = './punch-right.png';
    punchLeftImg  = new Image(); punchLeftImg.src  = './punch-left.png';
    punchJumpImg  = new Image(); punchJumpImg.src  = './punch-jump.png';
    punchFallImg  = new Image(); punchFallImg.src  = './punch-fall.png';
    punchSadImg   = new Image(); punchSadImg.src   = './punch-sad.png';
    punchHappyImg = new Image(); punchHappyImg.src = './punch-happy.png';
    punchIdleImg  = new Image(); punchIdleImg.src  = './punch-idle.png';

    punch.img = punchIdleImg;
    punchIdleImg.onload = function () {
        context.drawImage(punch.img, punch.x, punch.y, punch.width, punch.height);
    };

    platformImg = new Image();
    platformImg.src = './platform-punch.png';
    platformImg.onerror = function () { platformImg.src = './platform.png'; };

    initPlayFunSDK();

    // Start
    velocityY = initialVelocityY;
    placePlatforms();
    gameStarted = true;
    lastFrameTime = performance.now();
    requestAnimationFrame(update);

    // Controls
    document.addEventListener('keydown', movePunch);
    document.addEventListener('keyup', stopPunch);
    board.addEventListener('touchstart', handleTouchStart, { passive: false });
    board.addEventListener('touchmove', handleTouchMove, { passive: false });
    board.addEventListener('touchend', handleTouchEnd, { passive: false });

    restartBtn.addEventListener('click', restartGame);
    restartBtn.addEventListener('touchend', function (e) {
        e.preventDefault();
        e.stopPropagation();
        restartGame();
    });

    // --- Init Background Music & Volume Control ---
    bgMusic = document.getElementById('bg-music');
    volumeBtn = document.getElementById('volume-btn');
    volumeSlider = document.getElementById('volume-slider');

    // Load saved volume preferences
    let savedVolume = localStorage.getItem('punchJumpVolume');
    let savedMuted = localStorage.getItem('punchJumpMuted');
    if (savedVolume !== null) currentVolume = parseFloat(savedVolume);
    if (savedMuted !== null) isMuted = savedMuted === 'true';

    bgMusic.volume = isMuted ? 0 : currentVolume;
    volumeSlider.value = currentVolume * 100;
    updateVolumeIcon();
    updateSliderBackground();

    // Start music on first user interaction (autoplay policy)
    function startMusicOnInteraction() {
        if (musicStarted) return;
        musicStarted = true;
        bgMusic.play().catch(() => {});
        document.removeEventListener('click', startMusicOnInteraction);
        document.removeEventListener('keydown', startMusicOnInteraction);
        document.removeEventListener('touchstart', startMusicOnInteraction);
    }
    document.addEventListener('click', startMusicOnInteraction);
    document.addEventListener('keydown', startMusicOnInteraction);
    document.addEventListener('touchstart', startMusicOnInteraction);

    // Volume button: toggle mute
    volumeBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        isMuted = !isMuted;
        bgMusic.volume = isMuted ? 0 : currentVolume;
        updateVolumeIcon();
        localStorage.setItem('punchJumpMuted', isMuted);
    });

    // Volume slider: adjust volume
    volumeSlider.addEventListener('input', function (e) {
        e.stopPropagation();
        currentVolume = this.value / 100;
        isMuted = currentVolume === 0;
        bgMusic.volume = currentVolume;
        updateVolumeIcon();
        updateSliderBackground();
        localStorage.setItem('punchJumpVolume', currentVolume);
        localStorage.setItem('punchJumpMuted', isMuted);
    });

    // Prevent slider/button from triggering game controls
    let volumeControl = document.getElementById('volume-control');
    volumeControl.addEventListener('keydown', function(e) { e.stopPropagation(); });
    volumeControl.addEventListener('keyup', function(e) { e.stopPropagation(); });
    volumeControl.addEventListener('touchstart', function(e) { e.stopPropagation(); }, { passive: true });
    volumeControl.addEventListener('touchmove', function(e) { e.stopPropagation(); }, { passive: true });
    volumeControl.addEventListener('touchend', function(e) { e.stopPropagation(); }, { passive: true });
    volumeControl.addEventListener('mousedown', function(e) { e.stopPropagation(); });
};

// ============================================================
// GAME LOOP — deltaTime-based for consistent speed on all displays
// ============================================================
function update(timestamp) {
    requestAnimationFrame(update);
    if (gameOver) return;

    // Calculate delta time and scale factor
    let deltaTime = timestamp - lastFrameTime;
    lastFrameTime = timestamp;

    // Clamp deltaTime to avoid huge jumps (e.g. after tab switch)
    if (deltaTime > 100) deltaTime = TARGET_FRAME_TIME;

    let dt = deltaTime / TARGET_FRAME_TIME; // 1.0 at 60fps, 0.5 at 120fps, etc.

    context.clearRect(0, 0, board.width, board.height);

    // --- Punch horizontal movement ---
    punch.x += velocityX * dt;

    // Wrap around screen edges
    if (punch.x > boardWidth) punch.x = -punch.width;
    else if (punch.x + punch.width < 0) punch.x = boardWidth;

    // --- Gravity & vertical movement ---
    velocityY += gravity * dt;
    punch.y += velocityY * dt;

    // --- Camera: keep Punch visible on screen ---
    // If Punch goes above the camera threshold, scroll everything down
    const cameraThreshold = boardHeight * 0.25; // keep Punch no higher than top 25%
    if (punch.y < cameraThreshold) {
        let scrollAmount = cameraThreshold - punch.y;
        punch.y = cameraThreshold;
        // Push all platforms down by the same amount
        for (let i = 0; i < platformArray.length; i++) {
            platformArray[i].y += scrollAmount;
        }
    }

    // Fall off screen = game over
    if (punch.y > board.height) {
        gameOver = true;
        handleGameOver();
    }

    // --- Sprite selection ---
    if (happyFlashTimer > 0) {
        punch.img = punchHappyImg;
        happyFlashTimer -= dt;
    } else if (velocityY < -2) {
        punch.img = punchJumpImg;
    } else if (velocityY > 2) {
        punch.img = punchFallImg;
    } else if (velocityX > 0) {
        punch.img = punchRightImg;
    } else if (velocityX < 0) {
        punch.img = punchLeftImg;
    } else {
        punch.img = punchIdleImg;
    }

    context.drawImage(punch.img, punch.x, punch.y, punch.width, punch.height);

    // --- Platforms: scroll & collision ---
    let landed = false;
    for (let i = 0; i < platformArray.length; i++) {
        let plat = platformArray[i];

        // Scroll platforms down when Punch is rising in upper 3/4
        if (velocityY < 0 && punch.y < boardHeight * 0.75) {
            plat.y -= velocityY * dt;
        }

        // Collision: only when falling (velocityY > 0) and only ONCE per fall
        if (!landed && velocityY > 0 && detectCollision(punch, plat)) {
            velocityY = initialVelocityY;
            happyFlashTimer = 3;  // short flash, no input delay
            landed = true;
        }

        context.drawImage(plat.img, plat.x, plat.y, plat.width, plat.height);
    }

    // Remove off-screen platforms and spawn new ones above
    while (platformArray.length > 0 && platformArray[0].y >= boardHeight) {
        platformArray.shift();
        spawnPlatformAbove();
    }

    // --- Score ---
    updateScore(dt);
    drawScoreBadge();

    // SDK points
    if (score > 0 && score - lastPointsSent >= POINTS_SEND_INTERVAL) {
        let pts = score - lastPointsSent;
        sendPointsToSDK(pts);
        lastPointsSent = score;
    }
}

// ============================================================
// COLLISION — tight hitbox matching visible bamboo pixels
// ============================================================
function detectCollision(punch, plat) {
    let feetTop    = punch.y + punch.height * 0.8;
    let feetBottom = punch.y + punch.height;
    let feetLeft   = punch.x + punch.width * 0.15;
    let feetRight  = punch.x + punch.width * 0.85;

    let platLeft   = plat.x + 2;
    let platRight  = plat.x + plat.width - 2;
    let platTop    = plat.y + 3;
    let platBottom = plat.y + plat.height - 3;

    return feetRight > platLeft &&
           feetLeft < platRight &&
           feetBottom >= platTop &&
           feetTop <= platBottom;
}

// ============================================================
// PLATFORMS — fewer, with progressive spacing
// ============================================================
function getDifficultyFactor() {
    return Math.min(score / DIFFICULTY_SCORE, 1.0);
}

function getRandomGap() {
    let d = getDifficultyFactor();
    let minGap = BASE_GAP_MIN + (MAX_GAP_MIN - BASE_GAP_MIN) * d;
    let maxGap = BASE_GAP_MAX + (MAX_GAP_MAX - BASE_GAP_MAX) * d;
    return minGap + Math.random() * (maxGap - minGap);
}

function placePlatforms() {
    platformArray = [];

    platformArray.push({
        img: platformImg,
        x: boardWidth / 2 - platformWidth / 2,
        y: boardHeight - 50,
        width: platformWidth,
        height: platformHeight
    });

    let lastY = boardHeight - 50;
    for (let i = 0; i < INITIAL_PLATFORM_COUNT; i++) {
        let gap = BASE_GAP_MIN + Math.random() * (BASE_GAP_MAX - BASE_GAP_MIN);
        lastY -= gap;
        let randomX = Math.floor(Math.random() * (boardWidth - platformWidth));
        platformArray.push({
            img: platformImg,
            x: randomX,
            y: lastY,
            width: platformWidth,
            height: platformHeight
        });
    }
}

function spawnPlatformAbove() {
    let highestY = boardHeight;
    for (let p of platformArray) {
        if (p.y < highestY) highestY = p.y;
    }

    let gap = getRandomGap();
    let newY = highestY - gap;
    let randomX = Math.floor(Math.random() * (boardWidth - platformWidth));

    platformArray.push({
        img: platformImg,
        x: randomX,
        y: newY,
        width: platformWidth,
        height: platformHeight
    });
}

// ============================================================
// SCORE — clean, deterministic scoring based on height
// ============================================================
function updateScore(dt) {
    if (velocityY < 0 && punch.y < boardHeight * 0.75) {
        let heightGain = Math.abs(velocityY) * dt;
        maxScore += Math.floor(heightGain);
        if (score < maxScore) {
            score = maxScore;
        }
    }
}

// ============================================================
// SCORE BADGE
// ============================================================
function drawScoreBadge() {
    context.fillStyle = 'rgba(255, 248, 240, 0.82)';
    context.beginPath();
    context.roundRect(6, 6, 120, 46, 10);
    context.fill();

    context.fillStyle = '#c0522a';
    context.font = 'bold 17px "Segoe UI", sans-serif';
    context.shadowColor = 'rgba(0,0,0,0.15)';
    context.shadowBlur = 2;
    context.fillText('\u{1F412} ' + score, 14, 26);

    context.font = '12px "Segoe UI", sans-serif';
    context.fillStyle = '#a06040';
    context.fillText('Best: ' + highScore, 14, 44);
    context.shadowBlur = 0;
}

// ============================================================
// GAME OVER
// ============================================================
async function handleGameOver() {
    if (score > highScore) {
        highScore = score;
        localStorage.setItem('punchJumpHighScore', highScore);
    }

    let remainingPoints = score - lastPointsSent;
    if (remainingPoints > 0) {
        sendPointsToSDK(remainingPoints);
        lastPointsSent = score;
    }

    finalScoreEl.textContent = score;
    gameOverOverlay.style.display = 'flex';
    await endGameSDK(score);
}

function restartGame() {
    gameOverOverlay.style.display = 'none';

    punch = {
        img: punchIdleImg,
        x: punchX,
        y: punchY,
        width: punchWidth,
        height: punchHeight
    };

    velocityX = 0;
    velocityY = initialVelocityY;
    score = 0;
    maxScore = 0;
    gameOver = false;
    happyFlashTimer = 0;
    bouncedThisFall = false;
    pointsSentThisRound = 0;
    lastPointsSent = 0;
    lastFrameTime = performance.now();
    placePlatforms();

    // Ensure music keeps playing after restart
    if (bgMusic && musicStarted && bgMusic.paused) {
        bgMusic.play().catch(() => {});
    }
}

// ============================================================
// KEYBOARD CONTROLS
// ============================================================
function movePunch(e) {
    if (e.code === 'ArrowRight' || e.code === 'KeyD') {
        velocityX = moveSpeed;
    } else if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
        velocityX = -moveSpeed;
    } else if (e.code === 'Space' && gameOver) {
        restartGame();
    }
}

function stopPunch(e) {
    if (e.code === 'ArrowRight' || e.code === 'KeyD' ||
        e.code === 'ArrowLeft' || e.code === 'KeyA') {
        velocityX = 0;
    }
}

// ============================================================
// VOLUME HELPERS
// ============================================================
function updateVolumeIcon() {
    if (!volumeBtn) return;
    if (isMuted || currentVolume === 0) {
        volumeBtn.textContent = '\u{1F507}';  // muted
    } else if (currentVolume < 0.35) {
        volumeBtn.textContent = '\u{1F509}';  // low volume
    } else {
        volumeBtn.textContent = '\u{1F50A}';  // high volume
    }
}

function updateSliderBackground() {
    if (!volumeSlider) return;
    let val = volumeSlider.value;
    volumeSlider.style.background = `linear-gradient(to right, #e8834a 0%, #e8834a ${val}%, #ddd ${val}%, #ddd 100%)`;
}

// ============================================================
// TOUCH CONTROLS — responsive, no dead zone delay
// ============================================================
function handleTouchStart(e) {
    e.preventDefault();
    if (e.touches.length > 0) {
        touchStartX = e.touches[0].clientX;
        touchCurrentX = touchStartX;
        isTouching = true;
    }
}

function handleTouchMove(e) {
    e.preventDefault();
    if (!isTouching || e.touches.length === 0) return;

    touchCurrentX = e.touches[0].clientX;
    let diff = touchCurrentX - touchStartX;
    // Small dead zone of 5px to avoid accidental movement
    if (diff > 5) velocityX = moveSpeed;
    else if (diff < -5) velocityX = -moveSpeed;
    else velocityX = 0;
}

function handleTouchEnd(e) {
    e.preventDefault();
    touchStartX = null;
    touchCurrentX = null;
    isTouching = false;
    velocityX = 0;
}
