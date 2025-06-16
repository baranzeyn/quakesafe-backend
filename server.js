const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

// Firebase Admin SDK yapılandırması
// Firebase private key dosyasını yükleyin
admin.initializeApp({
  credential: admin.credential.applicationDefault(), // veya cert()
});

// MySQL bağlantısı
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: 'quakesafe123',
  database: 'quakesafe',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

// ✅ 3 Veri Kaynağı Konfigürasyonu
const DATA_SOURCES = {
  AFAD: {
    name: "AFAD",
    baseUrl: "https://deprem.afad.gov.tr/apiv2/event/filter",
    icon: "🏛️",
    formatDate: (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      const hours = String(date.getHours()).padStart(2, "0");
      const minutes = String(date.getMinutes()).padStart(2, "0");
      const seconds = String(date.getSeconds()).padStart(2, "0");
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    },
    buildParams: (startTime, endTime) => ({
      start: startTime,
      end: endTime,
      minmag: 1.0,
      orderby: "timedesc"
    }),
    parseResponse: (data) => data || [],
    parseEarthquake: (eq) => ({
      id: eq.eventID || `afad_${eq.latitude}_${eq.longitude}_${eq.date}`,
      location: eq.location || "Bilinmeyen Konum",
      magnitude: parseFloat(eq.magnitude || 0).toFixed(1),
      latitude: parseFloat(eq.latitude),
      longitude: parseFloat(eq.longitude),
      depth: parseFloat(eq.depth || 0).toFixed(1),
      timestamp: eq.date || new Date().toISOString(),
      source: "AFAD"
    })
  },

  KANDILLI: {
    name: "Kandilli",
    baseUrl: "https://api.orhanaydogdu.com.tr/deprem/kandilli/live",
    icon: "🔬",
    formatDate: (date) => date.toISOString(),
    buildParams: () => ({}),
    parseResponse: (data) => data.result || [],
    parseEarthquake: (eq) => ({
      id: eq.earthquake_id || `kandilli_${eq.geojson.coordinates[1]}_${eq.geojson.coordinates[0]}_${eq.date_time}`,
      location: eq.title || "Bilinmeyen Konum",
      magnitude: parseFloat(eq.mag || 0).toFixed(1),
      latitude: parseFloat(eq.geojson.coordinates[1]),
      longitude: parseFloat(eq.geojson.coordinates[0]),
      depth: parseFloat(eq.depth || 0).toFixed(1),
      timestamp: eq.date_time || new Date().toISOString(),
      source: "Kandilli"
    })
  },

  EMSC: {
    name: "EMSC",
    baseUrl: "https://www.seismicportal.eu/fdsnws/event/1/query",
    icon: "🌍",
    formatDate: (date) => date.toISOString(),
    buildParams: (startTime, endTime) => ({
      format: "json",
      starttime: startTime,
      endtime: endTime,
      minlatitude: 35.0,
      maxlatitude: 43.0,
      minlongitude: 25.0,
      maxlongitude: 45.0,
      minmagnitude: 1.0,
      limit: 100
    }),
    parseResponse: (data) => data.events || [],
    parseEarthquake: (eq) => ({
      id: eq.eventid || `emsc_${eq.latitude}_${eq.longitude}_${eq.time}`,
      location: eq.region || "Bilinmeyen Bölge",
      magnitude: parseFloat(eq.magnitude || 0).toFixed(1),
      latitude: parseFloat(eq.latitude),
      longitude: parseFloat(eq.longitude),
      depth: parseFloat(eq.depth || 0).toFixed(1),
      timestamp: eq.time || new Date().toISOString(),
      source: "EMSC"
    })
  }
};

// ✅ Veri kaynağı kontrolü - Ana fonksiyon
async function checkDataSourceForEarthquakes(sourceKey) {
  const source = DATA_SOURCES[sourceKey];
  if (!source) {
    throw new Error(`Bilinmeyen veri kaynağı: ${sourceKey}`);
  }

  console.log(`🔍 ${source.name} API kontrolü başlatılıyor...`);

  try {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const startTime = source.formatDate(twoHoursAgo);
    const endTime = source.formatDate(now);

    console.log(`⏰ ${source.name} zaman aralığı:`, startTime, "->", endTime);

    // API request
    const params = source.buildParams(startTime, endTime);
    const response = await axios.get(source.baseUrl, {
      params: params,
      timeout: 30000,
      headers: {
        "User-Agent": "QuakeSafe-App/1.0",
        "Accept": "application/json"
      }
    });

    console.log(`📡 ${source.name} API yanıtı alındı. Status: ${response.status}`);

    const earthquakes = source.parseResponse(response.data);
    const earthquakeCount = earthquakes.length || 0;

    console.log(`📊 ${source.name}: ${earthquakeCount} deprem bulundu`);

    if (earthquakeCount > 0) {
      return await processEarthquakesForNotifications(earthquakes, source);
    } else {
      return {
        success: false,
        source: source.name,
        message: `${source.name}: Son 2 saatte deprem bulunamadı`
      };
    }
  } catch (error) {
    console.error(`❌ ${source.name} API hatası:`, error.message);

    if (error.response) {
      console.error(`API Response Error: ${error.response.status} - ${error.response.statusText}`);
    }

    throw error;
  }
}

// ✅ Deprem bildirimleri işleme
async function processEarthquakesForNotifications(earthquakes, source) {
  let processedCount = 0;
  let totalSent = 0;

  // MySQL'den kullanıcıları al
  const [users] = await pool.execute('SELECT * FROM user_tokens');

  if (users.length === 0) {
    console.log("⚠️ Kayıtlı kullanıcı bulunamadı");
    return {success: false, message: "Kayıtlı kullanıcı yok"};
  }

  console.log(`👥 ${users.length} kullanıcı bulundu`);

  // Her depremi işle
  for (const rawEarthquake of earthquakes) {
    try {
      const earthquake = source.parseEarthquake(rawEarthquake);

      console.log(`📍 ${source.name} depremi: ${earthquake.location} - Büyüklük: ${earthquake.magnitude}`);

      let earthquakeSentCount = 0;
      const promises = [];

      // Her kullanıcı için kontrol et
      for (const user of users) {
        if (!user.token) continue;

        // Bu kullanıcının veri kaynağı tercihini kontrol et
        const userPrefs = await getUserPreferences(user.token);

        // Eğer kullanıcı belirli bir veri kaynağı seçmişse ve bu onun seçimi değilse, atla
        if (userPrefs.selectedDataSource && userPrefs.selectedDataSource !== source.name) {
          console.log(`⚠️ Kullanıcı ${user.token.slice(-10)} farklı veri kaynağı seçmiş: ${userPrefs.selectedDataSource}`);
          continue;
        }

        // Bildirim gönderildi mi kontrolü
        const [existingNotifications] = await pool.execute(
          'SELECT * FROM user_notifications WHERE earthquake_id = ? AND user_token = ?',
          [earthquake.id, user.token]
        );

        if (existingNotifications.length > 0) {
          continue; // Zaten gönderilmiş
        }

        // Bildirim kriterlerini kontrol et
        const shouldSend = await shouldSendEarthquakeNotification(earthquake, user);

        if (shouldSend.send) {
          const message = createNotificationMessage(earthquake, user, shouldSend, source);

          const sendPromise = admin.messaging().send(message)
            .then(async () => {
              console.log(`✅ ${source.name} bildirimi gönderildi: ${earthquake.location} -> ${user.token.slice(-10)}`);
              earthquakeSentCount++;

              // Bildirim geçmişi kaydet
              await pool.execute(
                `INSERT INTO user_notifications
                (earthquake_id, user_token, location, magnitude, distance, timestamp, source, notification_type)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  earthquake.id,
                  user.token,
                  earthquake.location,
                  earthquake.magnitude,
                  shouldSend.distance || "0",
                  new Date().toISOString(),
                  earthquake.source,
                  shouldSend.type
                ]
              );
            })
            .catch((error) => {
              console.error(`❌ ${source.name} notification hatası:`, error.message);
            });

          promises.push(sendPromise);
        }
      }

      await Promise.all(promises);

      if (earthquakeSentCount > 0) {
        processedCount++;
        totalSent += earthquakeSentCount;
        console.log(`✅ ${earthquake.location}: ${earthquakeSentCount} kullanıcıya bildirim gönderildi`);
      }
    } catch (error) {
      console.error("❌ Deprem işleme hatası:", error.message);
    }
  }

  return {
    success: true,
    source: source.name,
    message: `${source.name}: ${processedCount} deprem işlendi, ${totalSent} bildirim gönderildi`,
    processedCount,
    totalSent,
    totalFoundCount: earthquakes.length
  };
}

// ✅ Kullanıcı tercihlerini getir
async function getUserPreferences(userToken) {
  try {
    const [prefs] = await pool.execute(
      'SELECT * FROM user_preferences WHERE user_token = ?',
      [userToken]
    );

    if (prefs.length > 0) {
      return prefs[0];
    }
    return {selectedDataSource: null}; // Default: tüm kaynakları dinle
  } catch (error) {
    console.error("Kullanıcı tercihleri alınamadı:", error);
    return {selectedDataSource: null};
  }
}

// ✅ Bildirim gönderme kriterleri
async function shouldSendEarthquakeNotification(earthquake, userData) {
  const magnitude = parseFloat(earthquake.magnitude);

  // Kullanıcı lokasyonu varsa mesafe kontrolü
  if (userData.latitude && userData.longitude) {
    const distance = calculateDistance(
      earthquake.latitude,
      earthquake.longitude,
      parseFloat(userData.latitude),
      parseFloat(userData.longitude)
    );

    // 140km mesafe ve 4.0+ büyüklük
    if (distance <= 140 && magnitude >= 4.0) {
      return {
        send: true,
        type: "proximity",
        distance: distance.toFixed(1)
      };
    }
  }

  // Büyük depremler için genel bildirim (5.0+)
  if (magnitude >= 5.0) {
    return {
      send: true,
      type: "magnitude",
      distance: "0"
    };
  }

  return {send: false, reason: "Kriter karşılanmadı"};
}

// ✅ Bildirim mesajı oluştur
function createNotificationMessage(earthquake, userData, criteria, source) {
  const title = `${source.icon} ${source.name} Deprem Uyarısı`;
  const body = `${earthquake.location} - ${earthquake.magnitude} büyüklük${criteria.distance && criteria.distance !== "0" ? ` (${criteria.distance} km)` : ""}`;

  return {
    token: userData.token,
    notification: {
      title: title,
      body: body
    },
    data: {
      earthquakeId: earthquake.id,
      location: earthquake.location,
      magnitude: earthquake.magnitude,
      latitude: earthquake.latitude.toString(),
      longitude: earthquake.longitude.toString(),
      depth: earthquake.depth,
      timestamp: earthquake.timestamp,
      distance: criteria.distance || "0",
      source: earthquake.source,
      type: "earthquake_alert"
    }
  };
}

// ✅ Mesafe hesaplama
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// ======================== HTTP ENDPOINTS ========================

// ✅ Ana sayfa
app.get('/', (req, res) => {
  res.json({
    status: 'QuakeSafe API çalışıyor',
    timestamp: new Date().toISOString(),
    endpoints: [
      'GET /api/health',
      'POST /api/check-afad',
      'POST /api/check-kandilli',
      'POST /api/check-emsc',
      'POST /api/register-token',
      'POST /api/update-location',
      'POST /api/update-preferences'
    ]
  });
});

// ✅ Sağlık kontrolü
app.get('/api/health', (req, res) => {
  res.json({status: 'OK', timestamp: new Date().toISOString()});
});

// ✅ Her veri kaynağı için ayrı endpoint
app.post('/api/check-afad', async (req, res) => {
  try {
    const result = await checkDataSourceForEarthquakes("AFAD");
    res.json(result);
  } catch (error) {
    res.status(500).json({success: false, error: error.message});
  }
});

app.post('/api/check-kandilli', async (req, res) => {
  try {
    const result = await checkDataSourceForEarthquakes("KANDILLI");
    res.json(result);
  } catch (error) {
    res.status(500).json({success: false, error: error.message});
  }
});

app.post('/api/check-emsc', async (req, res) => {
  try {
    const result = await checkDataSourceForEarthquakes("EMSC");
    res.json(result);
  } catch (error) {
    res.status(500).json({success: false, error: error.message});
  }
});

// ✅ Kullanıcı token kaydetme
app.post('/api/register-token', async (req, res) => {
  try {
    const {token, latitude, longitude} = req.body;

    if (!token) {
      return res.status(400).json({error: 'Token gerekli'});
    }

    await pool.execute(
      `INSERT INTO user_tokens (token, latitude, longitude, created_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
       latitude = VALUES(latitude),
       longitude = VALUES(longitude),
       updated_at = NOW()`,
      [token, latitude || null, longitude || null, new Date()]
    );

    res.json({success: true, message: 'Token başarıyla kaydedildi'});
  } catch (error) {
    console.error('Token kaydetme hatası:', error);
    res.status(500).json({error: error.message});
  }
});

// ✅ Kullanıcı lokasyon güncelleme
app.post('/api/update-location', async (req, res) => {
  try {
    const {token, latitude, longitude} = req.body;

    if (!token || !latitude || !longitude) {
      return res.status(400).json({error: 'Token, latitude ve longitude gerekli'});
    }

    await pool.execute(
      'UPDATE user_tokens SET latitude = ?, longitude = ?, updated_at = NOW() WHERE token = ?',
      [parseFloat(latitude), parseFloat(longitude), token]
    );

    res.json({success: true, message: 'Lokasyon başarıyla güncellendi'});
  } catch (error) {
    console.error('Lokasyon güncelleme hatası:', error);
    res.status(500).json({error: error.message});
  }
});

// ✅ Kullanıcı veri kaynağı tercihi güncelleme
app.post('/api/update-preferences', async (req, res) => {
  try {
    const {token, selectedDataSource} = req.body;

    if (!token) {
      return res.status(400).json({error: 'Token gerekli'});
    }

    await pool.execute(
      `INSERT INTO user_preferences (user_token, selected_data_source, updated_at)
       VALUES (?, ?, NOW())
       ON DUPLICATE KEY UPDATE
       selected_data_source = VALUES(selected_data_source),
       updated_at = NOW()`,
      [token, selectedDataSource]
    );

    res.json({
      success: true,
      message: 'Veri kaynağı tercihi güncellendi',
      selectedDataSource: selectedDataSource
    });
  } catch (error) {
    console.error('Veri kaynağı tercihi güncelleme hatası:', error);
    res.status(500).json({error: error.message});
  }
});

// ======================== ZAMANLANMIŞ KONTROLLER ========================

// ✅ Her veri kaynağı için zamanlanmış kontrol
// Her 2 dakikada AFAD
cron.schedule('*/2 * * * *', async () => {
  console.log("⏰ Zamanlanmış AFAD kontrolü...");
  try {
    const result = await checkDataSourceForEarthquakes("AFAD");
    console.log("✅ AFAD kontrolü tamamlandı:", result.message);
  } catch (error) {
    console.error("❌ AFAD scheduled check hatası:", error.message);
  }
});

// Her 2 dakikada Kandilli (1 dakika offset)
cron.schedule('1-59/2 * * * *', async () => {
  console.log("⏰ Zamanlanmış Kandilli kontrolü...");
  try {
    const result = await checkDataSourceForEarthquakes("KANDILLI");
    console.log("✅ Kandilli kontrolü tamamlandı:", result.message);
  } catch (error) {
    console.error("❌ Kandilli scheduled check hatası:", error.message);
  }
});

// Her 4 dakikada EMSC (30 saniye offset)
cron.schedule('30-58/4 * * * *', async () => {
  console.log("⏰ Zamanlanmış EMSC kontrolü...");
  try {
    const result = await checkDataSourceForEarthquakes("EMSC");
    console.log("✅ EMSC kontrolü tamamlandı:", result.message);
  } catch (error) {
    console.error("❌ EMSC scheduled check hatası:", error.message);
  }
});

// ✅ Sunucuyu başlat
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 QuakeSafe API sunucusu ${PORT} portunda çalışıyor`);
  console.log(`📡 Endpoint: http://localhost:${PORT}`);
});

module.exports = app;