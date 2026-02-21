/**
 * Web Worker for ZK proof generation
 *
 * This worker runs snarkjs.groth16.fullProve() in a separate thread
 * to avoid blocking the main UI thread during proof generation (5-15 seconds).
 *
 * Message format (from main thread):
 * {
 *   moves: number[],      // 512-element array (padded move history)
 *   puzzle: Puzzle,        // Puzzle object from contract
 *   tick_count: number     // Total ticks used in solution
 * }
 *
 * Response format (to main thread):
 * Success: { proof, publicSignals }
 * Error: { error: string }
 */

// Import snarkjs from CDN
importScripts('https://cdn.jsdelivr.net/npm/snarkjs@0.7.6/build/snarkjs.min.js');

// Paths to WASM and zkey files
const WASM_PATH = '/zk/zknight.wasm';
const ZKEY_PATH = 'https://zknight-assets.wazowsky.id/zknight_final.zkey';

// Cache API key — bump the version suffix if the zkey is ever regenerated
const ZKEY_CACHE_NAME = 'zknight-zkey-v1';

/**
 * Fetch the zkey file, using the Cache API for persistence across sessions.
 * On first call: downloads from R2, stores in cache, returns Uint8Array.
 * On subsequent calls: loads from cache without hitting the network.
 * @returns {Promise<Uint8Array>}
 */
async function fetchZkeyBytes() {
    const cache = await caches.open(ZKEY_CACHE_NAME);
    const cached = await cache.match(ZKEY_PATH);
    if (cached) {
        console.log('[ProveWorker] zkey loaded from Cache API');
        return new Uint8Array(await cached.arrayBuffer());
    }
    console.log('[ProveWorker] zkey not cached — downloading from R2...');
    const res = await fetch(ZKEY_PATH);
    if (!res.ok) throw new Error(`Failed to fetch zkey: ${res.status} ${res.statusText}`);
    await cache.put(ZKEY_PATH, res.clone());
    console.log('[ProveWorker] zkey downloaded and stored in Cache API');
    return new Uint8Array(await res.arrayBuffer());
}

/**
 * Build the full circuit input matching the ZKnight circom template.
 *
 * Circuit signals (from zknight.circom):
 *   signal input grid_width;               // scalar (always 11)
 *   signal input grid_height;              // scalar (always 7)
 *   signal input knight_a_start[2];        // [x, y]
 *   signal input knight_b_start[2];        // [x, y]
 *   signal input goal_a[2];               // [x, y] — where Knight A must end
 *   signal input goal_b[2];               // [x, y] — where Knight B must end
 *   signal input walls[26][2];             // padded with OOB [grid_width, grid_height]
 *   signal input static_tnt[8][2];         // padded with OOB
 *   signal input barrel_paths[2][16][2];   // [barrel][step][x/y]
 *   signal input barrel_path_lengths[2];   // actual lengths <= 16
 *   signal input tick_count;               // actual ticks used <= 512
 *   signal input puzzle_id;                // puzzle identifier
 *   signal input moves[512];               // 0=Up, 1=Down, 2=Left, 3=Right, 4=NoOp (PRIVATE)
 */
function buildCircuitInput(moves, puzzle, tick_count) {
    // Out-of-bounds sentinel matches circuit convention: [grid_width, grid_height]
    const grid_width = puzzle.grid_width || 11;
    const grid_height = puzzle.grid_height || 7;
    const OOB = [String(grid_width), String(grid_height)];

    // Pad walls to exactly 16 entries
    const walls = [];
    for (const w of (puzzle.walls || [])) {
        walls.push([String(w.x), String(w.y)]);
    }
    while (walls.length < 26) {
        walls.push(OOB.slice());
    }

    // Pad static_tnt to exactly 8 entries
    const static_tnt = [];
    for (const t of (puzzle.static_tnt || [])) {
        static_tnt.push([String(t.x), String(t.y)]);
    }
    while (static_tnt.length < 8) {
        static_tnt.push(OOB.slice());
    }

    // Pad barrel_paths: exactly 2 barrels, each with 16 path steps
    const barrels = puzzle.moving_barrels || [];
    const barrel_paths = [];
    const barrel_path_lengths = [];

    for (let b = 0; b < 2; b++) {
        const path = [];
        if (b < barrels.length && barrels[b].path) {
            const realPath = barrels[b].path;
            barrel_path_lengths.push(String(realPath.length));
            for (const pos of realPath) {
                path.push([String(pos.x), String(pos.y)]);
            }
        } else {
            barrel_path_lengths.push("1"); // dummy barrel with length 1
        }
        // Pad path to exactly 16 steps
        while (path.length < 16) {
            path.push(OOB.slice());
        }
        barrel_paths.push(path);
    }

    // Convert moves to strings
    const movesStr = moves.map(m => String(m));

    const input = {
        grid_width: String(grid_width),
        grid_height: String(grid_height),
        knight_a_start: [String(puzzle.knight_a_start.x), String(puzzle.knight_a_start.y)],
        knight_b_start: [String(puzzle.knight_b_start.x), String(puzzle.knight_b_start.y)],
        goal_a: [String(puzzle.goal_a.x), String(puzzle.goal_a.y)],
        goal_b: [String(puzzle.goal_b.x), String(puzzle.goal_b.y)],
        walls,
        static_tnt,
        barrel_paths,
        barrel_path_lengths,
        tick_count: String(tick_count),
        puzzle_id: String(puzzle.id),
        moves: movesStr,
    };

    return input;
}

/**
 * Main message handler
 */
self.onmessage = async function (e) {
    const {moves, puzzle, tick_count} = e.data;

    try {
        console.log('[ProveWorker] Starting proof generation...');
        console.log('[ProveWorker] Tick count:', tick_count);
        console.log('[ProveWorker] Puzzle ID:', puzzle.id);
        console.log('[ProveWorker] Grid:', puzzle.grid_width, 'x', puzzle.grid_height);
        console.log('[ProveWorker] Walls:', (puzzle.walls || []).length, '/ 16 slots');
        console.log('[ProveWorker] Static TNT:', (puzzle.static_tnt || []).length, '/ 8 slots');
        console.log('[ProveWorker] Barrels:', (puzzle.moving_barrels || []).length, '/ 2 slots');

        // Build full circuit input
        const input = buildCircuitInput(moves, puzzle, tick_count);

        // Load zkey from Cache API (downloads on first use, instant on repeat)
        const zkeyBytes = await fetchZkeyBytes();

        // Generate proof (this takes 5-15 seconds)
        const startTime = Date.now();
        const {proof, publicSignals} = await snarkjs.groth16.fullProve(
            input,
            WASM_PATH,
            { type: 'mem', data: zkeyBytes }
        );
        const duration = Date.now() - startTime;

        console.log('[ProveWorker] Proof generated successfully in', duration, 'ms');

        // Send proof back to main thread
        self.postMessage({proof, publicSignals});
    } catch (error) {
        console.error('[ProveWorker] Proof generation failed:', error);
        self.postMessage({
            error: error.message || 'Unknown error during proof generation',
        });
    }
};

console.log('[ProveWorker] Worker initialized and ready');
