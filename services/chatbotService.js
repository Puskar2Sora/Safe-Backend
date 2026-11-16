// backend/services/chatbotService.js

// Optional: Import your static documents for fallback handling
// (Adjust path if your data folder structure is different)
let chatbotDocuments = [];
try {
  chatbotDocuments = require('../data/chatbotDocuments.json');
} catch (e) {
  chatbotDocuments = [{ title: "Help Guide", content: "Please check the safety guide for assistance." }];
}

/**
 * Fallback function using static help guide documents
 */
function answerQuestion(question) {
  const matchedDoc = chatbotDocuments[0] || { 
    title: "Safety Assistant Guide", 
    content: "Make sure your device permissions and network connection are active for seamless contacts support." 
  };
  
  return {
    answer: matchedDoc.content,
    sources: [
      `Guide: ${matchedDoc.title}`,
      `Troubleshooting: ${matchedDoc.title}`,
      `Overview: ${matchedDoc.title}`
    ]
  };
}

/**
 * Main function handling account-aware queries via local Ollama instance
 */
async function answerWithAccount(question, userContext = {}) {
  const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  const model = process.env.OLLAMA_MODEL || 'llama3.2:3b';

  // Format the user context cleanly for the AI model
  const contextString = JSON.stringify(userContext, null, 2);

  try {
    const response = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: 'system',
            content: `You are an intelligent women's safety platform assistant. You have full access to the currently logged-in user's account details, profile, trusted contacts, and platform status. 
            
Here is the live account data for the current user:
${contextString}

Use this data to answer questions about their account, contacts, or features precisely. If the data is empty, politely let them know what account details are missing.`
          },
          {
            role: 'user',
            content: question
          }
        ],
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama server returned status ${response.status}`);
    }

    const data = await response.json();
    
    return {
      answer: data.message?.content || "I couldn't generate a response.",
      sources: ['Local AI Model (Ollama) - Account Aware']
    };

  } catch (error) {
    console.error("❌ OLLAMA FETCH ERROR:", error.message);
    const fallback = answerQuestion(question);
    return {
      ...fallback,
      warning: 'The local model is unavailable, so this answer uses the built-in help guide.',
      proposedAction: null
    };
  }
}

// Export functions cleanly at the bottom
module.exports = {
  answerQuestion,
  answerWithAccount
};