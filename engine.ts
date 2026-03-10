require('dotenv').config();
import { createClient } from "@supabase/supabase-js";
import http from 'http';

// 🚀 Railway Health Check Port (Optional but good)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('🎱 Bingo Engine is Running...');
}).listen(Number(PORT), '0.0.0.0', () => {
    console.log(`📡 Health-check server listening on port ${PORT}`);
});

/**
 * 🎱 BINGO CENTRAL GAME ENGINE
 * This script serves as the centralized orchestration backend for the Bingo game.
 * It continually checks the state of the rooms every second, drives the countdowns,
 * transitions rooms into 'playing', picks numbers sequentially, and transitions to 'finished'.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''; 

if (!supabaseUrl || !supabaseKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false }
});

const TICK_RATE_MS = 3000; // Engine ticks every 3 seconds
const COUNTDOWN_SECONDS = 30; // 30 seconds wait before game starts
const MIN_PLAYERS = 2; // Minimum users required to start a game

const WINNING_PATTERNS = [
    // Rows
    [0, 1, 2, 3, 4],
    [5, 6, 7, 8, 9],
    [10, 11, 12, 13, 14],
    [15, 16, 17, 18, 19],
    [20, 21, 22, 23, 24],
    // Columns
    [0, 5, 10, 15, 20],
    [1, 6, 11, 16, 21],
    [2, 7, 12, 17, 22],
    [3, 8, 13, 18, 23],
    [4, 9, 14, 19, 24],
    // Diagonals
    [0, 6, 12, 18, 24],
    [4, 8, 12, 16, 20],
];

async function runEngine() {
    console.log("🎱 Central Bingo Engine initialized... Starting engine loop.");

    // Initial check
    await tick();

    // Engine Heartbeat Loop
    setInterval(async () => {
        try {
            await tick();
        } catch (error) {
            console.error("Engine Tick Error:", error);
        }
    }, TICK_RATE_MS);
}

async function tick() {
    // 1. Fetch current status of all engine rooms
    const { data: rooms, error } = await supabase
        .from('rooms_engine')
        .select('*')
        .in('status', ['waiting', 'playing']);

    if (error) {
        console.error("Failed to fetch rooms:", error.message);
        return;
    }

    // 2. Ensuring there is ALWAYS at least one waiting room open for people to join
    if (!rooms || rooms.length === 0) {
        console.log("No active or waiting rooms. Spawning a new Bingo room...");
        const targetStartTime = new Date(Date.now() + (COUNTDOWN_SECONDS * 1000));
        
        await supabase.from('rooms_engine').insert({
            status: 'waiting',
            pool: 0.00,
            company_fee: 0.00,
            start_time: null
        });
        return;
    }

    // 3. Process each room according to its state
    for (const room of rooms) {
        if (room.status === 'waiting') {
            await processWaitingRoom(room);
        } else if (room.status === 'playing') {
            await processPlayingRoom(room);
        }
    }
}

async function processWaitingRoom(room: any) {
    // --- CHECK PARTICIPANTS ---
    const { data: participants, error: partErr } = await supabase
        .from('room_cards')
        .select('user_id')
        .eq('room_id', room.id);

    if (partErr) {
        console.error("Error checking participants:", partErr.message);
        return;
    }

    // Count unique users
    const uniqueUsers = new Set(participants?.map((p: { user_id: string }) => p.user_id)).size;

    // If start_time is null, we are WAITING for enough players to trigger the countdown
    if (!room.start_time) {
        if (uniqueUsers >= MIN_PLAYERS) {
            console.log(`Bingo Room ${room.id} now has ${uniqueUsers} players. STARTING COUNTDOWN.`);
            const targetStartTime = new Date(Date.now() + (COUNTDOWN_SECONDS * 1000));
            await supabase.from('rooms_engine').update({ start_time: targetStartTime.toISOString() }).eq('id', room.id);
        } else {
            // Just wait, no start_time yet
        }
        return;
    }

    const now = new Date();
    const startTime = new Date(room.start_time);

    // If countdown is already running and finished
    if (now >= startTime) {
        // One final check - did someone leave? (Unlikely with buy logic but safe to check)
        if (uniqueUsers >= MIN_PLAYERS) {
            console.log(`Bingo Room ${room.id} countdown ended. STARTING GAME.`);
            await supabase.from('rooms_engine').update({ status: 'playing' }).eq('id', room.id);
        } else {
            // Players dropped below limit during countdown, reset start_time to null to wait again
            console.log(`Room ${room.id} lost players during countdown. Resetting to wait...`);
            await supabase.from('rooms_engine').update({ start_time: null }).eq('id', room.id);
        }
    }
}

async function processPlayingRoom(room: any) {
    // 1. Fetch historically called numbers
    const { data: calledNumbers, error: callErr } = await supabase
        .from('called_numbers')
        .select('number')
        .eq('room_id', room.id);

    if (callErr) {
        console.error(`Error fetching calls for ${room.id}:`, callErr.message);
        return;
    }

    const calledArray = calledNumbers?.map((n: { number: number }) => n.number) || [];

    // 2. Check if the game has exhausted all 75 numbers
    if (calledArray.length >= 75) {
        console.log(`Room ${room.id} exhausted all numbers. Closing without winner.`);
        await finishAndReset(room.id);
        return;
    }

    // 3. Number Calling Logic: Random unique number 1-75
    const availableNumbers = Array.from({ length: 75 }, (_, i) => i + 1).filter(n => !calledArray.includes(n));
    if (availableNumbers.length === 0) return;
    const nextNumber = availableNumbers[Math.floor(Math.random() * availableNumbers.length)];

    console.log(`Room [${room.id.substring(0,8)}...] Calls -> ${nextNumber}`);

    // 4. Save to DB.
    const { error: insErr } = await supabase.from('called_numbers').insert({ room_id: room.id, number: nextNumber });
    if (insErr) return;

    // 5. AUTOMATIC WINNER DETECTION
    // Add the newly called number to our local set for checking
    calledArray.push(nextNumber);
    const calledSet = new Set(calledArray);

    // Fetch all cards in this room
    const { data: cards, error: cardsErr } = await supabase
        .from('room_cards')
        .select('*')
        .eq('room_id', room.id);

    if (cardsErr || !cards) return;

    let winnerFound = false;
    for (const card of cards) {
        const isBingo = WINNING_PATTERNS.some(pattern => 
            pattern.every(index => index === 12 || calledSet.has(card.card_numbers[index]))
        );

        if (isBingo) {
            console.log(`🏆 WINNER DETECTED! Room: ${room.id}, Card: ${card.id}, User: ${card.user_id}`);
            winnerFound = true;
            
            // Process the win (RPC handle payout, status changes, etc.)
            const { error: winErr } = await supabase.rpc('process_bingo_win', {
                p_room_id: room.id,
                p_user_id: card.user_id,
                p_card_id: card.id
            });

            if (winErr) {
                console.error("Error processing winner RPC:", winErr.message);
            }
            break; // Stop checking after first winner in this tick
        }
    }

    if (winnerFound) {
        await finishAndReset(room.id);
    }
}

async function finishAndReset(roomId: string) {
    console.log(`Closing Room ${roomId} and starting a new round...`);
    
    // 1. Mark room as finished
    await supabase.from('rooms_engine')
        .update({ status: 'finished', end_time: new Date().toISOString() })
        .eq('id', roomId);
    
    // 2. Spawn a brand new waiting room (NO start_time yet)
    await supabase.from('rooms_engine').insert({
        status: 'waiting',
        pool: 0.00,
        company_fee: 0.00,
        start_time: null
    });
}



// Boot up
runEngine();
