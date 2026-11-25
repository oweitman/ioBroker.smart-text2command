const CONFIG = {
    favoritesRoot: 'squeezeboxrpc.0.Favorites',
    playerCmd: 'squeezeboxrpc.0.Players.SqueezeLiving.cmdPlayFavorite',
    minSimilarity: 0.5,
    minScoreDifference: 0.05,
    maxAlternatives: 5,
    debug: true,
};

function normalize(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function phonetic(text) {
    return normalize(text)
        .replace(/sch/g, 'sh')
        .replace(/tsch/g, 'ch')
        .replace(/ph/g, 'f')
        .replace(/ck/g, 'k')
        .replace(/qu/g, 'kw')
        .replace(/tz/g, 'z')
        .replace(/th/g, 't')
        .replace(/v/g, 'f')
        .replace(/w/g, 'v')
        .replace(/z/g, 's')
        .replace(/c(?=[eiy])/g, 's')
        .replace(/c/g, 'k')
        .replace(/y/g, 'i')
        .replace(/([a-z])\1+/g, '$1')
        .replace(/\s/g, '');
}

function levenshtein(a, b) {
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

    for (let i = 1; i <= a.length; i++) {
        const current = [i];

        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
        }

        previous = current;
    }

    return previous[b.length];
}

function similarity(a, b) {
    const maxLength = Math.max(a.length, b.length);
    return maxLength === 0 ? 1 : 1 - levenshtein(a, b) / maxLength;
}

function calculateSimilarity(search, name) {
    const a = normalize(search);
    const b = normalize(name);

    if (!a || !b) {
        return 0;
    }
    if (a === b) {
        return 1;
    }

    const textScore = similarity(a, b);
    const phoneticScore = similarity(phonetic(a), phonetic(b));
    const compactScore = similarity(a.replace(/\s/g, ''), b.replace(/\s/g, ''));
    let substringScore = 0;

    if (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))) {
        const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
        substringScore = 0.75 + 0.2 * ratio;
    }

    let wordScore = 0;
    const wordsA = a.split(' ');
    const wordsB = b.split(' ');

    if (wordsA.length === 1 || wordsB.length === 1) {
        for (const wordA of wordsA) {
            for (const wordB of wordsB) {
                if (Math.min(wordA.length, wordB.length) >= 4) {
                    wordScore = Math.max(
                        wordScore,
                        similarity(wordA, wordB) * 0.9,
                        similarity(phonetic(wordA), phonetic(wordB)) * 0.85,
                    );
                }
            }
        }
    }

    return Math.max(textScore, phoneticScore * 0.95, compactScore * 0.98, substringScore, wordScore);
}

async function getFavorites() {
    const favorites = [];
    const stateIds = [];

    $('state[id="' + CONFIG.favoritesRoot + '.*.Name"]').each(stateId => {
        stateIds.push(stateId);
    });

    for (const stateId of stateIds) {
        const nameState = await getStateAsync(stateId);
        const idStateId = stateId.replace(/\.Name$/, '.id');

        if (!existsState(idStateId)) {
            continue;
        }

        const idState = await getStateAsync(idStateId);
        if (!nameState || !nameState.val || !idState || idState.val === null || idState.val === undefined) {
            continue;
        }

        favorites.push({ name: String(nameState.val), id: idState.val });
    }

    return favorites;
}

onMessage('sbFavorit', async (data, callback) => {
    let result;

    try {
        if (CONFIG.debug) {
            log('sbFavorit: ' + JSON.stringify(data));
        }
        if (!data || typeof data.favorite !== 'string' || !normalize(data.favorite)) {
            throw new Error('Kein gültiger Favoritenname angegeben.');
        }

        const search = data.favorite.trim();
        const favorites = await getFavorites();

        const selection = data.clarification;

        if (selection !== null && selection !== undefined) {
            if (
                typeof selection !== 'object' ||
                typeof selection.id !== 'string' ||
                typeof selection.label !== 'string' ||
                typeof selection.value !== 'string' ||
                typeof selection.answer !== 'string'
            ) {
                throw new Error('Ungültige Antwort auf die Favoriten-Rückfrage.');
            }

            // Zweitaufruf: Die Auswahl stammt aus der zuvor angezeigten Optionsliste.
            const chosen = favorites.find(
                favorite => String(favorite.id) === selection.value && favorite.name === selection.label,
            );
            if (!chosen) {
                throw new Error('Der ausgewählte Favorit ist nicht mehr vorhanden.');
            }
            if (CONFIG.debug) {
                log(
                    'Rückfrage beantwortet mit: ' +
                        selection.answer +
                        ' | Favorit: ' +
                        chosen.name +
                        ' | Favorit: ' +
                        chosen.id,
                );
            }
            setState(CONFIG.playerCmd, chosen.id);
            result = { version: 1, status: 'success', text: 'Der Favorit wird gespielt ' + chosen.name };
        } else {
            const matches = favorites
                .map(favorite => ({ ...favorite, score: calculateSimilarity(search, favorite.name) }))
                .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'de'));

            if (CONFIG.debug) {
                log('Suche nach: ' + search);
                matches.slice(0, 5).forEach((match, index) => {
                    log(
                        index +
                            1 +
                            '. ' +
                            match.name +
                            ' | ID: ' +
                            match.id +
                            ' | Ähnlichkeit: ' +
                            (match.score * 100).toFixed(1) +
                            '%',
                    );
                });
            }

            const best = matches[0];
            if (!best || best.score < CONFIG.minSimilarity) {
                result = {
                    version: 1,
                    status: 'error',
                    text: 'Kein passender Favorit für "' + search + '" gefunden.',
                };
            } else {
                const alternatives = [];
                const seenIds = new Set();

                for (const match of matches) {
                    if (match.score < CONFIG.minSimilarity || best.score - match.score >= CONFIG.minScoreDifference) {
                        break;
                    }
                    if (!seenIds.has(String(match.id))) {
                        seenIds.add(String(match.id));
                        alternatives.push(match);
                    }
                    if (alternatives.length >= CONFIG.maxAlternatives) {
                        break;
                    }
                }

                if (alternatives.length > 1 && (best.score < 1 || alternatives[1].score === 1)) {
                    const options = alternatives.map((match, index) => ({
                        id: String(index + 1),
                        label: match.name,
                        value: String(match.id),
                    }));
                    result = {
                        version: 1,
                        status: 'clarification',
                        text:
                            'Welchen Favoriten meinst du? ' +
                            options.map(option => option.id + ': ' + option.label).join(', ') +
                            '.',
                        options,
                    };
                } else {
                    if (CONFIG.debug) {
                        log(
                            'Favorit gefunden: ' +
                                best.name +
                                ' | ID: ' +
                                best.id +
                                ' | Ähnlichkeit: ' +
                                (best.score * 100).toFixed(1) +
                                '%',
                        );
                    }
                    setState(CONFIG.playerCmd, best.id);
                    result = { version: 1, status: 'success', text: 'Der Favorit wird gespielt ' + best.name };
                }
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log('sbFavorit: ' + message, 'error');
        result = { version: 1, status: 'error', text: message };
    }

    log('Ausgabe: ' + result.text);
    if (typeof callback === 'function') {
        callback(result);
    }
});
