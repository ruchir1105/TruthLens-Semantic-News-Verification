const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'db.json');

function initDB() {
    if (!fs.existsSync(DB_PATH)) {
        fs.writeFileSync(DB_PATH, JSON.stringify({ history: [] }, null, 2));
    }
}

function readHistory() {
    initDB();
    const data = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(data).history;
}

function writeHistory(history) {
    initDB();
    const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    data.history = history;
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function addHistoryRecord(record) {
    const history = readHistory();
    history.unshift(record); // Add to top
    writeHistory(history);
}

function findRecentHistory(headline) {
    const history = readHistory();
    // Cache expiry: 6 hours
    const CACHE_MS = 6 * 60 * 60 * 1000;
    return history.find(r => 
        r.headline.toLowerCase() === headline.toLowerCase() && 
        (new Date() - new Date(r.timestamp)) < CACHE_MS
    );
}

function deleteHistoryRecord(id) {
    let history = readHistory();
    history = history.filter(r => r.id !== String(id) && r.id !== Number(id));
    writeHistory(history);
}

function clearAllHistory() {
    writeHistory([]);
}

module.exports = {
    readHistory,
    addHistoryRecord,
    findRecentHistory,
    deleteHistoryRecord,
    clearAllHistory
};
