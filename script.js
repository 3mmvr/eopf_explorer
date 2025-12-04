const STAC_API_URL = 'https://stac.core.eopf.eodc.eu/search';
const COLLECTIONS_URL = 'https://stac.core.eopf.eodc.eu/collections';
const STAC_BROWSER_BASE = 'https://stac.browser.user.eopf.eodc.eu/collections'; 

let map;
let collectionLayers = {}; 
let currentData = { features: [], context: {} };
let allFeatures = [];
let nextLink = null;
let minTimestamp, maxTimestamp; // Global ranges

const DISTINCT_COLORS = [
    '#2563eb', '#7c3aed', '#db2777', '#16a34a', '#0d9488', 
    '#ca8a04', '#ea580c', '#dc2626', '#9333ea', '#0891b2', '#be123c'
];
const collectionColorMap = {};

document.addEventListener('DOMContentLoaded', () => {
    initMap();
    setDefaultDates();
    fetchCollections();
    
    document.getElementById('searchForm').addEventListener('submit', (e) => handleSearch(e));
    document.getElementById('geoBtn').addEventListener('click', geocodeLocation);
    document.getElementById('locationSearch').addEventListener('keypress', (e) => { if(e.key==='Enter'){e.preventDefault();geocodeLocation()} });
    document.getElementById('sortOrder').addEventListener('change', (e) => handleSearch(e));
    
    // Cloud Slider Logic
    const cloudSlider = document.getElementById('cloudSlider');
    cloudSlider.addEventListener('input', (e) => {
        document.getElementById('cloudVal').textContent = `Max ${e.target.value}%`;
        applyFilters();
    });

    // Time Slider Logic
    const tStart = document.getElementById('timeStart');
    const tEnd = document.getElementById('timeEnd');
    
    [tStart, tEnd].forEach(el => {
        el.addEventListener('input', () => {
            const v1 = parseInt(tStart.value);
            const v2 = parseInt(tEnd.value);
            if (v1 > v2) { // prevent crossover
                if (el === tStart) tStart.value = v2;
                else tEnd.value = v1;
            }
            updateTimeHighlight();
            updateTimeLabel();
            applyFilters();
        });
    });
});

function initMap() {
    if (typeof L === 'undefined') { setTimeout(initMap, 200); return; }
    if(map) return; 
    map = L.map('map', { zoomControl: false }).setView([48.0, 14.0], 5);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; CARTO' }).addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);
}

// --- TIME SLIDER HELPERS ---
function initTimeSlider(features) {
    if (!features || features.length === 0) {
        document.getElementById('timeFilterContainer').classList.add('hidden');
        return;
    }
    
    const times = features.map(f => new Date(f.properties.datetime).getTime());
    minTimestamp = Math.min(...times);
    maxTimestamp = Math.max(...times);
    
    // Just one moment in time?
    if (minTimestamp === maxTimestamp) {
        // artificially widen range by 1 day for UI
        minTimestamp -= 86400000;
        maxTimestamp += 86400000;
    }

    const tStart = document.getElementById('timeStart');
    const tEnd = document.getElementById('timeEnd');
    
    tStart.min = minTimestamp; tStart.max = maxTimestamp; tStart.value = minTimestamp;
    tEnd.min = minTimestamp; tEnd.max = maxTimestamp; tEnd.value = maxTimestamp;
    
    updateTimeHighlight();
    updateTimeLabel();
    document.getElementById('timeFilterContainer').classList.remove('hidden');
}

function updateTimeHighlight() {
    const start = parseInt(document.getElementById('timeStart').value);
    const end = parseInt(document.getElementById('timeEnd').value);
    const total = maxTimestamp - minTimestamp;
    const left = ((start - minTimestamp) / total) * 100;
    const right = 100 - (((end - minTimestamp) / total) * 100);
    
    const hl = document.getElementById('timeTrackHighlight');
    hl.style.left = left + "%";
    hl.style.right = right + "%";
}

function updateTimeLabel() {
    const s = new Date(parseInt(document.getElementById('timeStart').value));
    const e = new Date(parseInt(document.getElementById('timeEnd').value));
    const opts = { month: 'short', day: 'numeric' };
    // Add year if different
    if (s.getFullYear() !== new Date().getFullYear()) opts.year = '2-digit';
    
    document.getElementById('timeVal').textContent = `${s.toLocaleDateString(undefined, opts)} - ${e.toLocaleDateString(undefined, opts)}`;
}

async function fetchCollections() {
    const list = document.getElementById('collectionList');
    try {
        const res = await fetch(COLLECTIONS_URL);
        const data = await res.json();
        list.innerHTML = '';
        
        let colorIndex = 0;
        const collections = (data.collections || []).sort((a,b) => a.id.localeCompare(b.id));

        collections.forEach(c => {
            if (!collectionColorMap[c.id]) {
                collectionColorMap[c.id] = DISTINCT_COLORS[colorIndex % DISTINCT_COLORS.length];
                colorIndex++;
            }
            const color = collectionColorMap[c.id];
            
            const div = document.createElement('div');
            div.innerHTML = `
                <label class="flex items-center gap-3 p-2 hover:bg-slate-50 rounded-lg cursor-pointer transition-colors group collection-item">
                    <input type="checkbox" name="collections" value="${c.id}" class="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500">
                    <div class="flex-1 min-w-0">
                        <div class="text-xs font-bold text-slate-700 truncate" title="${c.title}">${c.title || c.id}</div>
                    </div>
                    <span class="w-3 h-3 rounded-full shadow-sm shrink-0" style="background-color: ${color}"></span>
                </label>`;
            list.appendChild(div);
        });
    } catch (err) {
        list.innerHTML = '<div class="text-xs text-red-500">Failed to load collections.</div>';
    }
}

function getCollectionColor(id) { return collectionColorMap[id] || '#64748b'; }

async function handleSearch(e, urlOverride = null, isAppend = false) {
    if(e) e.preventDefault();
    const btn = document.getElementById('searchBtn');
    const loadMoreBtn = document.getElementById('loadMoreBtn');
    const errorMsg = document.getElementById('errorMsg');
    const sortDir = document.getElementById('sortOrder').value;
    
    const bbox = document.getElementById('bboxInput').value.split(',').map(Number);
    const cols = Array.from(document.querySelectorAll('input[name="collections"]:checked')).map(c => c.value);

    if (!cols.length) { errorMsg.textContent = "Select at least one collection."; errorMsg.classList.remove('hidden'); return; }
    if (bbox.length !== 4 || bbox.some(isNaN)) { errorMsg.textContent = "Invalid Location/BBox."; errorMsg.classList.remove('hidden'); return; }
    errorMsg.classList.add('hidden');

    if(!isAppend) {
        btn.innerHTML = `<div class="loader"></div>`;
        btn.disabled = true;
        document.getElementById('resultsContainer').innerHTML = ''; 
        allFeatures = [];
        Object.values(collectionLayers).forEach(layer => map.removeLayer(layer));
        collectionLayers = {};
        updateDiscreteLayerList([]);
        document.getElementById('timeFilterContainer').classList.add('hidden');
    } else {
        loadMoreBtn.innerHTML = 'Loading...';
        loadMoreBtn.disabled = true;
    }

    const payload = {
        collections: cols,
        bbox: bbox,
        datetime: `${toRfc3339(document.getElementById('startDate').value)}/${toRfc3339(document.getElementById('endDate').value, true)}`,
        limit: 100, 
        sortby: [{ field: "properties.datetime", direction: sortDir }]
    };

    try {
        let res;
        if (urlOverride) {
            res = await fetch(urlOverride); 
        } else {
            res = await fetch(STAC_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        }

        if (!res.ok) throw new Error("API Error");
        const data = await res.json();
        
        const nextLinkObj = data.links ? data.links.find(l => l.rel === 'next') : null;
        nextLink = nextLinkObj ? nextLinkObj.href : null;
        
        if (isAppend) {
            allFeatures = [...allFeatures, ...data.features];
        } else {
            allFeatures = data.features || [];
            currentData.context = data.context || {};
            // Only init time slider on first load
            initTimeSlider(allFeatures);
        }
        
        // Recalculate slider range if appended data expands it?
        // For simplicity, we keep initial range or re-init if significant change logic needed.
        // Re-init for now to cover new dates loaded
        initTimeSlider(allFeatures);

        applyFilters();

        if (nextLink) {
            loadMoreBtn.classList.remove('hidden');
            loadMoreBtn.innerHTML = 'Load More Results';
            loadMoreBtn.disabled = false;
        } else {
            loadMoreBtn.classList.add('hidden');
        }

    } catch (err) {
        errorMsg.textContent = "Search failed: " + err.message;
        errorMsg.classList.remove('hidden');
    } finally {
        btn.innerHTML = 'Find Satellite Data';
        btn.disabled = false;
    }
}

function loadMore() { if(nextLink) handleSearch(null, nextLink, true); }

function applyFilters() {
    const maxCloud = parseInt(document.getElementById('cloudSlider').value, 10);
    
    // Time range filter
    const tStartVal = parseInt(document.getElementById('timeStart').value);
    const tEndVal = parseInt(document.getElementById('timeEnd').value);

    const filtered = allFeatures.filter(f => {
        const cloud = f.properties['eo:cloud_cover'];
        const time = new Date(f.properties.datetime).getTime();
        
        const cloudOk = (cloud === undefined || cloud <= maxCloud);
        const timeOk = (time >= tStartVal && time <= tEndVal);
        
        return cloudOk && timeOk;
    });

    const renderData = { ...currentData, features: filtered };
    renderResults(renderData);
    updateMapFeatures(renderData);
    
    const activeCols = [...new Set(filtered.map(f => f.collection))];
    updateDiscreteLayerList(activeCols);

    updateCount(filtered.length);
    updateTimeline(filtered);
}

// --- DISCRETE LAYER MANAGER ---
function updateDiscreteLayerList(activeCollections) {
    const list = document.getElementById('layerList');
    if (activeCollections.length === 0) {
        list.innerHTML = '<div class="text-xs text-slate-400 italic">No layers active.</div>';
        return;
    }
    list.innerHTML = '';
    
    activeCollections.forEach(colId => {
        const color = getCollectionColor(colId);
        const div = document.createElement('div');
        div.className = "flex items-center justify-between p-2 rounded hover:bg-slate-50 cursor-pointer group";
        div.onclick = () => bringLayerToFront(colId); 
        div.innerHTML = `
            <div class="flex items-center gap-2 overflow-hidden">
                <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background-color: ${color}"></span>
                <span class="text-xs text-slate-700 truncate select-none">${colId}</span>
            </div>
            <button onclick="event.stopPropagation(); toggleLayerVisibility('${colId}', this)" class="text-slate-400 hover:text-slate-600">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
            </button>
        `;
        list.appendChild(div);
    });
}

function toggleLayerVisibility(colId, btn) {
    const layer = collectionLayers[colId];
    if (!layer) return;
    if (map.hasLayer(layer)) {
        map.removeLayer(layer);
        btn.classList.add('opacity-50');
    } else {
        map.addLayer(layer);
        btn.classList.remove('opacity-50');
    }
}

function bringLayerToFront(colId) {
    const layer = collectionLayers[colId];
    if (layer && map.hasLayer(layer)) {
        layer.bringToFront();
    }
}

function updateMapFeatures(data) {
    const grouped = {};
    data.features.forEach(f => {
        if (!grouped[f.collection]) grouped[f.collection] = [];
        grouped[f.collection].push(f);
    });

    Object.keys(grouped).forEach(colId => {
        if (!collectionLayers[colId]) {
            collectionLayers[colId] = L.featureGroup().addTo(map);
        }
        const layerGroup = collectionLayers[colId];
        layerGroup.clearLayers(); 

        const color = getCollectionColor(colId);
        L.geoJSON(grouped[colId], {
            style: { color: color, weight: 2, opacity: 1, fillColor: color, fillOpacity: 0.2 },
            onEachFeature: (feature, layer) => {
                layer.on('click', () => openModal(feature.id));
                layer.on('mouseover', function () { this.setStyle({ fillOpacity: 0.4 }); });
                layer.on('mouseout', function () { this.setStyle({ fillOpacity: 0.2 }); });
            }
        }).addTo(layerGroup);
    });

    Object.keys(collectionLayers).forEach(colId => {
        if (!grouped[colId]) {
            map.removeLayer(collectionLayers[colId]);
            delete collectionLayers[colId];
        }
    });
}

// --- RENDER ---
function renderResults(data) {
    const container = document.getElementById('resultsContainer');
    if (!data?.features?.length) {
        if(allFeatures.length > 0) container.innerHTML = '<div class="text-center py-8 text-xs text-slate-400">Hidden by Filters.</div>';
        else container.innerHTML = '<div class="text-center py-8 text-xs text-slate-400">No results found.</div>';
        return;
    }

    container.innerHTML = data.features.map((item) => {
        const color = getCollectionColor(item.collection);
        const date = new Date(item.properties.datetime).toLocaleDateString();
        const platform = item.properties['platform'] || 'sat';
        const thumbKey = Object.keys(item.assets).find(k => k.includes('thumbnail') || k.includes('preview') || k.includes('quicklook'));
        const thumbUrl = thumbKey ? item.assets[thumbKey].href : null;
        
        return `
        <div class="result-card bg-white rounded-xl p-3 border border-slate-100 cursor-pointer relative overflow-hidden group shadow-sm flex gap-3" onclick="openModal('${item.id}')">
            <div class="w-1.5 self-stretch rounded-full flex-shrink-0" style="background-color: ${color}"></div>
            ${thumbUrl ? `<img src="${thumbUrl}" class="w-16 h-16 rounded-lg object-cover border border-slate-100 bg-slate-50 flex-shrink-0" onerror="this.style.display='none'">` : ''}
            <div class="flex-1 min-w-0 flex flex-col justify-center">
                <h3 class="text-xs font-bold text-slate-800 truncate mb-1" title="${item.id}">${item.id}</h3>
                <div class="flex gap-2 mb-1">
                        <span class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] font-bold uppercase">${platform}</span>
                        <span class="text-[10px] text-slate-400 font-medium pt-0.5">${date}</span>
                </div>
            </div>
        </div>`;
    }).join('');
}

// --- TIMELINE ---
function updateTimeline(features) {
    const container = document.getElementById('timelineContainer');
    const barsContainer = document.getElementById('timelineBars');
    if (features.length === 0) { container.classList.add('hidden'); return; }
    container.classList.remove('hidden');
    barsContainer.innerHTML = '';

    const dateCounts = {};
    features.forEach(f => {
        const day = f.properties.datetime.split('T')[0];
        dateCounts[day] = (dateCounts[day] || 0) + 1;
    });
    const sortedDates = Object.keys(dateCounts).sort();
    if(sortedDates.length === 0) return;
    const maxCount = Math.max(...Object.values(dateCounts));
    
    sortedDates.forEach(date => {
        const height = Math.max(10, (dateCounts[date] / maxCount) * 100);
        const bar = document.createElement('div');
        bar.className = 'timeline-bar flex-1 bg-slate-300 rounded-sm cursor-pointer relative group';
        bar.style.height = `${height}%`;
        bar.title = `${date}: ${dateCounts[date]}`;
        barsContainer.appendChild(bar);
    });
    document.getElementById('timelineRangeLabel').textContent = `${sortedDates[0]} - ${sortedDates[sortedDates.length-1]}`;
}

function updateCount(shownCount) {
    const summary = document.getElementById('dataRangeSummary');
    const text = document.getElementById('totalCountText');
    if (shownCount > 0) {
        summary.classList.remove('hidden');
        text.innerHTML = `Showing <b>${shownCount}</b> items`;
    } else {
        summary.classList.add('hidden');
    }
}

// --- MODAL ---
window.openModal = function(id) {
    const item = allFeatures.find(f => f.id === id);
    if (!item) return;
    document.getElementById('modalTitle').textContent = item.id;
    document.getElementById('modalDate').textContent = new Date(item.properties.datetime).toLocaleString();
    const badge = document.getElementById('modalCollectionBadge');
    badge.textContent = item.collection;
    badge.style.backgroundColor = getCollectionColor(item.collection);
    badge.style.color = '#fff';
    document.getElementById('openBrowserBtn').href = `${STAC_BROWSER_BASE}/${item.collection}/items/${item.id}`;
    
    window.currentItemId = item.id;
    window.currentCollectionId = item.collection;
    
    const code = `
from pystac_client import Client
client = Client.open("${STAC_API_URL.replace('/search','')}")
item = client.get_collection("${item.collection}").get_item("${item.id}")
print(item.assets)`.trim();
    document.getElementById('pythonCodeArea').value = code;

    const metaDiv = document.getElementById('modalMetadata');
    const props = item.properties;
    const importantKeys = ['platform', 'processing:level', 'eo:cloud_cover', 'gsd', 'instruments'];
    metaDiv.innerHTML = importantKeys.map(key => {
        if (props[key] === undefined) return '';
        const label = key.split(':').pop().toUpperCase().replace('_', ' ');
        let val = props[key]; if (typeof val === 'number') val = val.toFixed(2);
        return `<div class="bg-slate-50 p-2 rounded border border-slate-100"><div class="text-[10px] font-bold text-slate-400">${label}</div><div class="text-xs font-mono text-slate-700 truncate">${val}</div></div>`;
    }).join('');

    const assetsDiv = document.getElementById('modalAssets');
    assetsDiv.innerHTML = Object.entries(item.assets).slice(0, 6).map(([key, asset]) => `
        <div class="flex items-center justify-between p-2 border-b border-slate-50 last:border-0">
            <div class="flex flex-col min-w-0 pr-2"><span class="text-xs font-bold text-slate-700 truncate">${key}</span><span class="text-[10px] text-slate-400 truncate">${asset.type || ''}</span></div>
            <a href="${asset.href}" target="_blank" class="text-indigo-600 hover:text-indigo-800 text-xs font-bold">DL</a>
        </div>`).join('');
    document.getElementById('detailsModal').classList.remove('hidden');
}

window.closeModal = function() { document.getElementById('detailsModal').classList.add('hidden'); }
window.copyPythonSnippet = function() {
    const textArea = document.getElementById('pythonCodeArea');
    textArea.select(); navigator.clipboard.writeText(textArea.value);
}

function toRfc3339(date, end=false) {
    if (!date) return '';
    return new Date(date + (end ? 'T23:59:59Z' : 'T00:00:00Z')).toISOString().replace(/\.000Z$/, 'Z');
}
function setDefaultDates() {
    const end = new Date(); const start = new Date(); start.setDate(end.getDate() - 7);
    document.getElementById('endDate').value = end.toISOString().split('T')[0];
    document.getElementById('startDate').value = start.toISOString().split('T')[0];
    document.getElementById('bboxInput').value = "10.0, 45.0, 12.0, 47.0";
}
window.setDateRange = function(days) {
    const end = new Date(); const start = new Date(); start.setDate(end.getDate() - days);
    document.getElementById('endDate').value = end.toISOString().split('T')[0];
    document.getElementById('startDate').value = start.toISOString().split('T')[0];
}
async function geocodeLocation() {
    const query = document.getElementById('locationSearch').value;
    const status = document.getElementById('geoStatus');
    const bboxInput = document.getElementById('bboxInput');
    if (!query) return;
    status.textContent = "Locating...";
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`);
        const data = await res.json();
        if (data?.[0]) {
            const bb = data[0].boundingbox;
            bboxInput.value = `${parseFloat(bb[2]).toFixed(4)}, ${parseFloat(bb[0]).toFixed(4)}, ${parseFloat(bb[3]).toFixed(4)}, ${parseFloat(bb[1]).toFixed(4)}`;
            status.textContent = `Found: ${data[0].display_name.split(',')[0]}`;
            map.fitBounds([[bb[0], bb[2]], [bb[1], bb[3]]]);
        } else { status.textContent = "Not found."; }
    } catch (e) { status.textContent = "Error."; }
}
function clearMap() {
    Object.values(collectionLayers).forEach(l => map.removeLayer(l));
    collectionLayers = {};
    document.getElementById('resultsContainer').innerHTML = '<div class="text-center py-8 opacity-50"><p class="text-sm font-medium text-slate-400">Ready.</p></div>';
    document.getElementById('locationSearch').value = '';
    document.getElementById('geoStatus').textContent = '';
    document.getElementById('timelineContainer').classList.add('hidden');
    document.getElementById('timeFilterContainer').classList.add('hidden');
    updateDiscreteLayerList([]);
    allFeatures = []; nextLink = null; updateCount(0);
    document.getElementById('loadMoreBtn').classList.add('hidden');
}