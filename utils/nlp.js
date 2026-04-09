const stopWords = new Set(['the', 'is', 'at', 'which', 'on', 'in', 'a', 'to', 'of', 'and', 'for', 'with', 'as', 'by', 'an', 'this', 'that', 'are', 'was', 'were', 'be', 'will', 'it', 'from', 'but', 'not', 'have', 'has', 'had', 'they', 'we', 'you', 'he', 'she', 'or']);

function tokenize(text) {
    if (!text) return [];
    return text.toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(word => word.length > 2 && !stopWords.has(word));
}

function getTermFrequency(tokens) {
    const tf = {};
    tokens.forEach(token => {
        tf[token] = (tf[token] || 0) + 1;
    });
    return tf;
}

function cosineSimilarity(tf1, tf2) {
    const terms = new Set([...Object.keys(tf1), ...Object.keys(tf2)]);
    
    let dotProduct = 0;
    let mag1 = 0;
    let mag2 = 0;

    terms.forEach(term => {
        const val1 = tf1[term] || 0;
        const val2 = tf2[term] || 0;
        
        dotProduct += val1 * val2;
        mag1 += val1 * val1;
        mag2 += val2 * val2;
    });

    if (mag1 === 0 || mag2 === 0) return 0;
    
    return dotProduct / (Math.sqrt(mag1) * Math.sqrt(mag2));
}

function calculateSimilarity(text1, text2) {
    const tokens1 = tokenize(text1);
    const tokens2 = tokenize(text2);
    
    const tf1 = getTermFrequency(tokens1);
    const tf2 = getTermFrequency(tokens2);

    return cosineSimilarity(tf1, tf2);
}

module.exports = {
    tokenize,
    calculateSimilarity
};
