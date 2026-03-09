import { createClient } from "@supabase/supabase-js";
import 'dotenv/config';
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
async function runEngine() {
    console.log("🎱 Central Bingo Engine initialized... Starting engine loop.");
    // Initial check
    await tick();
    // Engine Heartbeat Loop
    setInterval(async () => {
        try {
            await tick();
        }
        catch (error) {
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
            start_time: targetStartTime.toISOString()
        });
        return;
    }
    // 3. Process each room according to its state
    for (const room of rooms) {
        if (room.status === 'waiting') {
            await processWaitingRoom(room);
        }
        else if (room.status === 'playing') {
            await processPlayingRoom(room);
        }
    }
}
async function processWaitingRoom(room) {
    // If start_time is null, initialize the timer
    if (!room.start_time) {
        const targetStartTime = new Date(Date.now() + (COUNTDOWN_SECONDS * 1000));
        await supabase.from('rooms_engine').update({ start_time: targetStartTime.toISOString() }).eq('id', room.id);
        return;
    }
    const now = new Date();
    const startTime = new Date(room.start_time);
    // If countdown is finished, Start the Game
    if (now >= startTime) {
        console.log(`Bingo Room ${room.id} is STARTING.`);
        await supabase.from('rooms_engine').update({ status: 'playing' }).eq('id', room.id);
    }
}
async function processPlayingRoom(room) {
    // 1. Fetch historically called numbers
    const { data: calledNumbers, error: callErr } = await supabase
        .from('called_numbers')
        .select('number')
        .eq('room_id', room.id);
    if (callErr) {
        console.error(`Error fetching calls for ${room.id}:`, callErr.message);
        return;
    }
    const calledArray = calledNumbers?.map((n) => n.number) || [];
    // 2. Check if the game has exhausted all 75 numbers
    if (calledArray.length >= 75) {
        console.log(`Room ${room.id} exhausted all numbers. Closing room.`);
        await supabase.from('rooms_engine').update({ status: 'finished', end_time: new Date().toISOString() }).eq('id', room.id);
        // Spawn a brand new waiting room
        console.log("Spawning new room...");
        const targetStartTime = new Date(Date.now() + (COUNTDOWN_SECONDS * 1000));
        await supabase.from('rooms_engine').insert({
            status: 'waiting',
            pool: 0.00,
            company_fee: 0.00,
            start_time: targetStartTime.toISOString()
        });
        return;
    }
    // 3. Number Calling Logic: Random unique number 1-75
    const availableNumbers = Array.from({ length: 75 }, (_, i) => i + 1).filter(n => !calledArray.includes(n));
    if (availableNumbers.length === 0)
        return;
    const nextNumber = availableNumbers[Math.floor(Math.random() * availableNumbers.length)];
    console.log(`Room [${room.id.substring(0, 8)}...] Calls -> ${nextNumber}`);
    // 4. Save to DB. Supabase Realtime picks this up and broadcasts!
    await supabase.from('called_numbers').insert({ room_id: room.id, number: nextNumber });
}
// -------------------------------------------------------------------------
// 🚀 RENDER HEALTH CHECK SERVER
// -------------------------------------------------------------------------
import http from 'http';
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('🎱 Bingo Engine is Running...');
}).listen(PORT, () => {
    console.log(`📡 Health-check server listening on port ${PORT}`);
});
// Boot up
runEngine();
