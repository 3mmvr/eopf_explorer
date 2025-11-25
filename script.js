const STAC_API_URL = 'https://stac.core.eopf.eodc.eu/search';
const COLLECTIONS_URL = 'https://stac.core.eopf.eodc.eu/collections';
const STAC_BROWSER_BASE = 'https://stac.browser.user.eopf.eodc.eu/collections'; 

let map, geoJsonLayer, currentData;

// --- Distinct Color Palette ---
const DISTINCT_COLORS = [
    '#2563eb', // Blue (S1 GRD)
    '#7c3aed', // Violet (S1 SLC)
    '#db2777', // Pink (S1 OCN)
    '#16a34a', // Green (S2 L2A)
    '#0d9488', // Teal (S2 L1C)
    '#ca8a04', // Gold (S3 EFR)
    '#ea580c', // Orange (S3 ERR)
    '#dc2626', // Red (S3 RBT)
    '#9333ea', // Purple
    '#0891b2', // Cyan
    '#be123c'  // Rose
];
const collectionColorMap = {};

document.addEventListener('DOMContentLoaded', () => {
    initMap();
    setDefaultDates();
    fetchCollections();
    
    document.getElementById('searchForm').addEventListener('submit', handleSearch);
    document.getElementById('geoBtn').addEventListener('click', geocodeLocation);
    document.getElementById('locationSearch').addEventListener('keypress', (e) => { if(e.key==='Enter'){e.preventDefault();geocodeLocation()} });
});

function initMap() {
    if (typeof L === 'undefined') { setTimeout(initMap, 200); return; }
    if(map) return; 
    map = L.map('map', { zoomControl: false }).setView([48.0, 14.0], 5);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; CARTO' }).addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);
}

async function fetchCollections() {
    const list = document.getElementById('collectionList');
    try {
        const res = await fetch(COLLECTIONS_URL);
        const data = await res.json();
        list.innerHTML = '';
        
        let colorIndex = 0;
        
        // Sort collections roughly by platform for readability
        const collections = (data.collections || []).sort((a,b) => a.id.localeCompare(b.id));

        collections.forEach(c => {
            // Assign unique color
            if (!collectionColorMap[c.id]) {
                collectionColorMap[c.id] = DISTINCT_COLORS[colorIndex % DISTINCT_COLORS.length];
                colorIndex++;
            }
            const color = collectionColorMap[c.id];
            
            const div = document.createElement('div');
            div.innerHTML = `
                <label class="flex items-center gap-3 p-2 hover:bg-white rounded-lg cursor-pointer transition-colors group collection-item">
                    <input type="checkbox" name="collections" value="${c.id}" class="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500">
                    <div class="flex-1 min-w-0">
                        <div class="text-xs font-bold text-slate-700 truncate" title="${c.title}">${c.title || c.id}</div>
                    </div>
                    <span class="w-3 h-3 rounded-full shadow-sm" style="background-color: ${color}"></span>
                </label>`;
            list.appendChild(div);
        });
    } catch (err) {
        list.innerHTML = '<div class="text-xs text-red-500">Failed to load collections.</div>';
    }
}

function getCollectionColor(id) {
    return collectionColorMap[id] || '#64748b';
}

async function handleSearch(e) {
    e.preventDefault();
    const btn = document.getElementById('searchBtn');
    const errorMsg = document.getElementById('errorMsg');
    const bbox = document.getElementById('bboxInput').value.split(',').map(Number);
    const cols = Array.from(document.querySelectorAll('input[name="collections"]:checked')).map(c => c.value);

    if (!cols.length) { errorMsg.textContent = "Select at least one collection."; errorMsg.classList.remove('hidden'); return; }
    if (bbox.length !== 4 || bbox.some(isNaN)) { errorMsg.textContent = "Invalid Location/BBox."; errorMsg.classList.remove('hidden'); return; }
    errorMsg.classList.add('hidden');

    const origText = btn.innerHTML;
    btn.innerHTML = `<div class="loader"></div>`;
    btn.disabled = true;

    const payload = {
        collections: cols,
        bbox: bbox,
        datetime: `${toRfc3339(document.getElementById('startDate').value)}/${toRfc3339(document.getElementById('endDate').value, true)}`,
        limit: 50,
        sortby: [{ field: "properties.datetime", direction: "desc" }]
    };

    try {
        const res = await fetch(STAC_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error("API Error");
        const data = await res.json();
        
        currentData = data;
        renderResults(currentData);
        updateMapFeatures(currentData);
        
        const summary = document.getElementById('dataRangeSummary');
        const rangeText = document.getElementById('rangeText');
        if (data.features.length) {
            summary.classList.remove('hidden');
            rangeText.textContent = `${data.features.length} Items Found`;
        } else {
            summary.classList.add('hidden');
        }

    } catch (err) {
        errorMsg.textContent = "Search failed: " + err.message;
        errorMsg.classList.remove('hidden');
    } finally {
        btn.innerHTML = origText;
        btn.disabled = false;
    }
}

function renderResults(data) {
    const container = document.getElementById('resultsContainer');
    if (!data?.features?.length) {
        container.innerHTML = '<div class="text-center py-4 text-xs font-bold text-slate-400">No results found.</div>';
        return;
    }

    container.innerHTML = data.features.map((item, idx) => {
        const color = getCollectionColor(item.collection);
        const date = new Date(item.properties.datetime).toLocaleDateString();
        const platform = item.properties['platform'] || 'sat';
        
        return `
        <div class="result-card bg-white rounded-xl p-3 border border-slate-100 cursor-pointer relative overflow-hidden group shadow-sm flex items-start gap-3" onclick="openModal(${idx})">
            <div class="w-1.5 self-stretch rounded-full" style="background-color: ${color}"></div>
            <div class="flex-1 min-w-0">
                <h3 class="text-xs font-bold text-slate-800 truncate mb-1" title="${item.id}">${item.id}</h3>
                <div class="flex gap-2 mb-2">
                        <span class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] font-bold uppercase">${platform}</span>
                        <span class="text-[10px] text-slate-400 font-medium pt-0.5">${date}</span>
                </div>
            </div>
            <div class="self-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <svg class="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
            </div>
        </div>`;
    }).join('');
}

function updateMapFeatures(data) {
    if (geoJsonLayer) map.removeLayer(geoJsonLayer);
    if (!data?.features?.length) return;
    
    geoJsonLayer = L.geoJSON(data, {
        style: (feature) => {
            const c = getCollectionColor(feature.collection);
            return { 
                color: c, 
                weight: 2,
                opacity: 1,
                fillColor: c, 
                fillOpacity: 0.2
            };
        },
        onEachFeature: (feature, layer) => {
            layer.on('click', () => {
                const idx = currentData.features.findIndex(f => f.id === feature.id);
                if (idx >= 0) openModal(idx);
            });
            layer.on('mouseover', function () { this.setStyle({ weight: 4, fillOpacity: 0.4 }); });
            layer.on('mouseout', function () { geoJsonLayer.resetStyle(this); });
        }
    }).addTo(map);
    map.fitBounds(geoJsonLayer.getBounds(), { padding: [50,50] });
}

// --- MODAL & EXTERNAL LINKS ---
window.openModal = function(idx) {
    const item = currentData.features[idx];
    if (!item) return;

    // 1. Header
    document.getElementById('modalTitle').textContent = item.id;
    document.getElementById('modalDate').textContent = new Date(item.properties.datetime).toLocaleString();
    
    const badge = document.getElementById('modalCollectionBadge');
    badge.textContent = item.collection;
    const color = getCollectionColor(item.collection);
    badge.style.backgroundColor = color;
    // Calculate approximate contrast
    badge.style.color = '#ffffff'; 

    // 2. Button URL
    const browserUrl = `${STAC_BROWSER_BASE}/${item.collection}/items/${item.id}`;
    document.getElementById('openBrowserBtn').href = browserUrl;

    // 3. Metadata Grid
    const metaDiv = document.getElementById('modalMetadata');
    const props = item.properties;
    const importantKeys = ['platform', 'processing:level', 'eo:cloud_cover', 'gsd', 'instruments', 's1:orbit_source'];
    
    metaDiv.innerHTML = importantKeys.map(key => {
        if (props[key] === undefined) return '';
        const label = key.split(':').pop().toUpperCase().replace('_', ' ');
        let val = props[key];
        if (typeof val === 'number') val = val.toFixed(2);
        return `
            <div class="bg-slate-50 p-2 rounded border border-slate-100">
                <div class="text-[10px] font-bold text-slate-400">${label}</div>
                <div class="text-xs font-mono text-slate-700 truncate" title="${val}">${val}</div>
            </div>`;
    }).join('');

    // 4. Quick Assets
    const assetsDiv = document.getElementById('modalAssets');
    assetsDiv.innerHTML = Object.entries(item.assets).slice(0, 5).map(([key, asset]) => {
        const type = asset.type || 'unknown';
        return `
            <div class="flex items-center justify-between p-2 border-b border-slate-50 last:border-0">
                <div class="flex flex-col min-w-0 pr-2">
                    <span class="text-xs font-bold text-slate-700 truncate">${key}</span>
                    <span class="text-[10px] text-slate-400 truncate">${type}</span>
                </div>
                <a href="${asset.href}" target="_blank" class="text-indigo-600 hover:text-indigo-800 text-xs font-bold">DL</a>
            </div>`;
    }).join('');

    document.getElementById('detailsModal').classList.remove('hidden');
}

window.closeModal = function() {
    document.getElementById('detailsModal').classList.add('hidden');
}

function toRfc3339(date, end=false) {
    if (!date) return '';
    return new Date(date + (end ? 'T23:59:59Z' : 'T00:00:00Z')).toISOString().replace(/\.000Z$/, 'Z');
}

function setDefaultDates() {
    const end = new Date();
    const start = new Date();
    start.setFullYear(end.getFullYear() - 1);
    document.getElementById('endDate').value = end.toISOString().split('T')[0];
    document.getElementById('startDate').value = start.toISOString().split('T')[0];
    document.getElementById('bboxInput').value = "10.0, 45.0, 12.0, 47.0";
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
    if(geoJsonLayer) map.removeLayer(geoJsonLayer);
    document.getElementById('resultsContainer').innerHTML = '<div class="text-center py-8 opacity-50"><p class="text-sm font-medium text-slate-400">Ready.</p></div>';
    document.getElementById('locationSearch').value = '';
    document.getElementById('keywordInput').value = '';
    document.getElementById('geoStatus').textContent = '';
}