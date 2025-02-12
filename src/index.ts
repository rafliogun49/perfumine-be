import { Hono } from 'hono'
import { handle } from 'hono/cloudflare-pages'
import { Context } from 'hono'
import axios from 'axios'

type Env = {
  TOGETHER_API_KEY: string
  CLOUDFLARE_API_KEY: string
  ACCOUNT_ID: string
  VECTORIZE_INDEX: string
  D1_DATABASE_ID: string
  EMAIL: string
}

const app = new Hono<{ Bindings: Env }>()
app.use(async (c, next) => {
  c.res.headers.set("Access-Control-Allow-Origin", "*");
  c.res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  await next();
})

app.options('/recommend-perfume', (c) => {
  c.res.headers.set("Access-Control-Allow-Origin", "*");
  c.res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  c.status(204);
  return c.text('');
});


app.post('/recommend-perfume', async (c: Context<{ Bindings: Env }>) => {
  try {
    const userAnswers = await c.req.json()
    const {name, email} = userAnswers
    console.log(name, email)
    // 🔹 Step 1: Generate Insight + Query dari AI
    const insight = await generateInsight(userAnswers, c.env)
    if (!insight || !insight.query) {
      return c.json({ error: 'Gagal generate insight dari AI.' }, 500)
    }

    // 🔹 Step 2: Convert Query ke Vector
    const queryVector = await getVector(insight.query, c.env)
    if (!queryVector || queryVector.length === 0) {
      return c.json({ error: 'Gagal mengonversi query ke vektor.' }, 500)
    }

    // 🔹 Step 3: Vector Search
    const topPerfumes = await searchPerfumes(queryVector, c.env)
    if (!topPerfumes || topPerfumes.length === 0) {
      return c.json({ error: 'Tidak ada parfum yang cocok ditemukan.' }, 404)
    }

    // 🔹 Step 4: Fetch Perfume Details
    const perfumeDetails = await fetchPerfumeDetails(topPerfumes, c.env)

    await saveUserResponse(c, name, email, userAnswers, insight, topPerfumes)
    
    return c.json({
      insight,
      recommendations: perfumeDetails
    })
  } catch (error) {
    console.error('❌ Error:', error.message)
    return c.json({ error: error.message }, 500)
  }
})



export default app
export const onRequest = handle(app)

// 📌 **Step 1: Generate Insight dari AI**
async function generateInsight(userAnswers: any, env: Env) {
  try {
    const prompt = generatePrompt(userAnswers)
    const response = await axios.post(
      'https://api.together.xyz/v1/chat/completions',
      {
        messages: [{ role: 'user', content: prompt }],
        model: 'deepseek-ai/DeepSeek-V3',
        max_tokens: 400,
        temperature: 0.7,
        top_p: 0.7,
        top_k: 50,
        repetition_penalty: 1,
        stop: ['<|end_of_text|>']
      },
      {
        headers: {
          Authorization: `Bearer ${env.TOGETHER_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    )
    console.log('🔍 Insight:', response.data.choices[0].message.content)
    return cleanAndParseJSON(response.data.choices[0].message.content)
  } catch (error) {
    console.error('❌ Error di generateInsight:', error.message)
    return null
  }
}

// 📌 **Step 2: Convert Query ke Vektor**
async function getVector(text: string, env: Env) {
  try {
    const response = await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/ai/run/@cf/baai/bge-base-en-v1.5`,
      { text },
      {
        headers: {
          'X-Auth-Email': env.EMAIL,
          'X-Auth-Key': env.CLOUDFLARE_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    )
    console.log('🔍 Vector:', response.data.result.data[0])
    return response.data.result.data[0]
  } catch (error) {
    console.error('❌ Error di getVector:', error.message)
    return []
  }
}

// 📌 **Step 3: Vector Search ke Cloudflare Vectorize**
async function searchPerfumes(queryVector: string[], env: Env) {
  try {
    const response = await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/vectorize/v2/indexes/perfume_index/query`,
      { vector: queryVector, topK: 5 },
      {
        headers: {
          'X-Auth-Email': env.EMAIL,
          'X-Auth-Key': env.CLOUDFLARE_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    )
    console.log('🔍 Top Perfumes:', response.data.result.matches.map((match: any) => match.id))
    return response.data.result.matches.map((match: any) => match.id)
  } catch (error) {
    console.error('❌ Error di searchPerfumes:', error.message)
    return []
  }
}

// 📌 **Step 4: Fetch Perfume Details from Cloudflare D1**
async function fetchPerfumeDetails(perfumeIds: string[], env: Env) {
  try {
    const perfumeIdsNum = perfumeIds.map(id => Number(id))
    console.log('🔍 Fetching Perfume Details:', perfumeIdsNum)
    const response = await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/d1/database/${env.D1_DATABASE_ID}/query`,
      {
        sql: `SELECT * FROM perfumes WHERE id IN (${perfumeIdsNum.map(() => '?').join(',')})`,
        params: perfumeIdsNum
      },
      {
        headers: {
          'X-Auth-Email': env.EMAIL,
          'X-Auth-Key': env.CLOUDFLARE_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    )

    return response.data.result[0].results
  } catch (error) {
    console.error('❌ Error di fetchPerfumeDetails:', error.message)
    return []
  }
}

async function saveUserResponse(c: Context<{ Bindings: Env }>, name: string, email: string, userAnswers: any, insight:{characteristics:string, ideal_scent:string, persona:string, query:string}, topPerfumes: string[]) {
  try {
    if(!name || !email) {
      return c.json({ error: 'Nama dan email harus diisi.' }, 400)
    }
    const stmt = `
      INSERT INTO user_responses (name, email, q1, q2, q3, q4, q5, q6, q7, q8, q9, q10, characteristics, ideal_scent, persona, query, recommendations)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      name,
      email,
      userAnswers.q1,
      userAnswers.q2,
      userAnswers.q3,
      userAnswers.q4,
      userAnswers.q5,
      userAnswers.q6,
      userAnswers.q7,
      userAnswers.q8,
      userAnswers.q9,
      userAnswers.q10,
      insight.characteristics,
      insight.ideal_scent,
      insight.persona,
      insight.query,
      JSON.stringify(topPerfumes) // Simpan sebagai JSON string
    ];

    const response = await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${c.env.ACCOUNT_ID}/d1/database/${c.env.D1_DATABASE_ID}/query`,
      { sql: stmt, params },
      {
        headers: {
          'X-Auth-Email': c.env.EMAIL,
          'X-Auth-Key': c.env.CLOUDFLARE_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
    if (!response.data.success) {
      console.error("❌ Gagal menyimpan ke D1:", response.data);
    } else {
      console.log("✅ Data user berhasil disimpan ke D1.");
    }
  } catch (error) {
    console.error('❌ Error:', error.message)
    return c.json({ error: 'Terjadi kesalahan saat menyimpan jawaban user.' }, 500)
  }
}

// 📌 **Helper: Generate AI Prompt**
function generatePrompt(answers: any) {
  return `
Berperanlah sebagai ahli parfum yang memberikan rekomendasi parfum terbaik untuk siapapun
Berdasarkan jawaban ${answers.name} terhadap preferensi parfum:

1 Tahan Lama: ${answers.q1}
2 Kapan Digunakan: ${answers.q2}
3 Kepribadian: ${answers.q3}
4 Aroma Favorit: ${answers.q4}
5 Nuansa Aroma: ${answers.q5}
6 Aktivitas Utama: ${answers.q6}
7 Parfum Spesial: ${answers.q7}
8 Gender Parfum: ${answers.q8}
9 Intensitas Aroma: ${answers.q9}
10 Kapan Dipakai: ${answers.q10}

**Tugas Anda:**  
1. **Analisis kepribadian user** berdasarkan pilihan parfum mereka.  
2. **Deskripsikan parfum ideal** mereka secara persuasif.  
3. **Buat query pencarian parfum** untuk database vektor.
4. Buat jawaban yang menarik, persuasif, informatif, sesuai dengan preferensi user, dan anda dapat menyebut nama saya.

**Format JSON yang diharapkan**:
{
  "characteristics": "Gambaran singkat tentang kepribadian ${answers.name}... max 225 karakter",
  "ideal_scent": "Deskripsi tentang parfum dan notes-notes yang mungkin cocok... max 300 karakter",
  "persona": "Satu kata yang menggambarkan ${answers.name}",
  "query": "Query singkat berbahasa indonesia untuk pencarian parfum"
}
  `
}

// 📌 **Helper: Parse AI JSON Output**
function cleanAndParseJSON(responseText: string) {
  try {
    let cleanedText = responseText.replace(/^```json\n/, '').replace(/\n```$/, '').trim()
    console.log('🧹 Cleaned JSON:', cleanedText)
    return JSON.parse(cleanedText)
  } catch (error) {
    console.error('❌ Error parsing JSON:', error.message)
    return null
  }
}