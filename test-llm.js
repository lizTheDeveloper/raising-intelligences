const OpenAI = require('openai');

async function test() {
  console.log("Initializing OpenAI client...");
  const client = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: {
      "HTTP-Referer": "https://raisingintelligences.com",
      "X-Title": "Raising Intelligences",
    },
  });

  const model = "qwen/qwen3.7-plus";
  console.log("Calling OpenAI chat.completions.create with model:", model);
  
  const start = Date.now();
  try {
    const response = await client.chat.completions.create({
      model: model,
      max_tokens: 1500,
      messages: [
        { role: "system", content: "You are the Psychologist narrator. Write a short Identity Document for Oliver, age 3." },
        { role: "user", content: "Oliver cried on his first day of school. The parent said: 'Oliver, don't worry. I'm right here with you. Let's take a deep breath together.'" },
      ],
    });
    const duration = (Date.now() - start) / 1000;
    console.log(`Success in ${duration}s!`);
    console.log("Response content:\n", response.choices[0]?.message?.content);
  } catch (err) {
    console.error("Failed with error:", err);
  }
}

test();
