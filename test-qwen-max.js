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

  const model = "qwen/qwen3.7-max";
  console.log("Calling OpenAI chat.completions.create with model:", model);
  
  const start = Date.now();
  try {
    const response = await client.chat.completions.create({
      model: model,
      max_tokens: 500,
      messages: [
        { role: "system", content: "You are the Psychologist narrator. Write a short narrative of Oliver's early adulthood." },
        { role: "user", content: "Identity Document:\nCore beliefs: the world is safe.\n\nWrite the story of Oliver's early adulthood." },
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
