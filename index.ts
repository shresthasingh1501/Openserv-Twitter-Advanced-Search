import { z } from 'zod'
import { Agent } from '@openserv-labs/sdk'
import 'dotenv/config'
import axios from 'axios' // Import axios for HTTP requests

// --- Configuration ---
const twitterApiBaseUrl = 'https://api.twitterapi.io'
const twitterApiKey = process.env.TWITTER_API_IO_KEY

// --- Validate API Key ---
if (!twitterApiKey) {
  console.error("ERROR: TWITTER_API_IO_KEY environment variable is not set.")
  process.exit(1) // Exit if the key is missing
}

// --- Agent Definition ---
const agent = new Agent({
  // Updated system prompt to reflect the new capability
  systemPrompt: 'You are an agent designed to search for tweets using advanced query criteria (keywords, users, dates, etc.) via the twitterapi.io service. You can perform complex searches beyond just fetching a single user\'s timeline.',
  // apiKey: process.env.OPENSERV_API_KEY // SDK reads this automatically
})

// --- REMOVED OLD CAPABILITY ---
// The fetchUserTweetsByUsername capability is no longer needed.

// --- Add NEW Capability for Advanced Search ---
agent.addCapability({
  name: 'advancedTweetSearch',
  description: `Performs an advanced search for tweets based on a query string. Supports complex queries like keywords, hashtags, mentions, specific users (from:username), dates (since:YYYY-MM-DD, until:YYYY-MM-DD), etc. Returns the most recent matching tweets first (up to ~20 per call by default from the API). Refer to Twitter's advanced search syntax for constructing queries. Example queries: '"artificial intelligence" from:elonmusk since:2023-01-01', '#opensource OR #AI', 'search term -exclude_word'.`,
  schema: z.object({
    query: z.string().describe(`The advanced search query string using Twitter's advanced search syntax (e.g., '"AI safety" from:openai', '#web3 since:2024-01-01', 'openserv.ai'). Required.`),
    // queryType is required by the API, defaults to 'Latest'
    queryType: z.enum(['Latest', 'Top']).default('Latest').describe('The type of search results to retrieve: "Latest" for most recent tweets, "Top" for most popular/relevant tweets. Defaults to "Latest".')
    // We are omitting the 'cursor' for pagination in this basic version.
    // The agent could potentially call this multiple times if needed,
    // or pagination could be added later if required.
  }),
  async run({ args }) {
    const { query, queryType } = args
    const apiUrl = `${twitterApiBaseUrl}/twitter/tweet/advanced_search`

    console.log(`Performing advanced search with query: "${query}", type: ${queryType} from ${apiUrl}`)

    try {
      const response = await axios.get(apiUrl, {
        params: {
          query: query,
          queryType: queryType
          // cursor: '' // Start without a cursor for the first page
        },
        headers: {
          'X-API-Key': twitterApiKey,
          'Accept': 'application/json'
        }
      });

      // --- Handle API Response ---
      const responseData = response.data;

      // Check specifically for the presence of the 'tweets' array in the success case for this endpoint
      if (!responseData || !Array.isArray(responseData.tweets)) {
         // This API endpoint doesn't seem to have a 'status' field in the success response based on docs
         const errorMessage = responseData?.message || responseData?.msg || 'Unknown API error or invalid data structure (missing tweets array).';
         console.error(`API returned unexpected data structure for query "${query}":`, errorMessage, responseData);
         return `Error: Failed to fetch tweets. API Response: ${errorMessage}`;
      }

      const tweetsArray = responseData.tweets;

      // Check if tweets array is empty
      if (tweetsArray.length === 0) {
        console.log(`No tweets found matching the query: "${query}".`);
        return `No tweets found matching the search query: "${query}".`;
      }

      // --- Format the Output ---
      // Determine a relevant title - using the query itself is often best
      let output = `**Search Results for Query "${query}" (Type: ${queryType}):**\n\n`;

      tweetsArray.forEach((tweet: any, index: number) => {
        const authorUsername = tweet.author?.userName || 'Unknown User';
        const tweetText = (tweet.text || '').substring(0, 250) + ( (tweet.text || '').length > 250 ? '...' : ''); // Truncate for brevity
        output += `${index + 1}. **Author:** @${authorUsername}\n`;
        output += `   **ID:** ${tweet.id}\n`;
        output += `   **Text:** ${tweetText}\n`;
        output += `   **Created:** ${tweet.createdAt}\n`;
        output += `   **Link:** ${tweet.url}\n`;
        output += `   **Stats:** Likes: ${tweet.likeCount || 0}, Retweets: ${tweet.retweetCount || 0}, Replies: ${tweet.replyCount || 0}, Views: ${tweet.viewCount || 0}\n\n`;
      });

       // Add pagination info if available (though we don't use the cursor yet)
       if (responseData.has_next_page && responseData.next_cursor) {
         output += `*Note: More results may be available (API indicates next page exists).*\n`;
       }

      const estimatedTokens = Math.ceil(output.length / 4);
      console.log(`Returning output with estimated ${estimatedTokens} tokens.`);

      // Keep total output limit check as safeguard for platform operation
      const maxTotalOutputLength = 25000;
      if (output.length > maxTotalOutputLength) {
          console.warn(`Total output length ${output.length} exceeds safety limit ${maxTotalOutputLength}. Truncating further.`);
          output = output.substring(0, maxTotalOutputLength) + "\n... [Total output truncated due to length limit]";
      }

      return output;

    } catch (error: any) {
      console.error(`Error performing advanced search for query "${query}":`, error);

      // --- Handle HTTP/Network Errors ---
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const apiMessage = error.response?.data?.msg || error.response?.data?.message || 'No specific message from API.';
        if (status === 401 || status === 403) {
          return `Error: Authentication failed. Please check if the TWITTER_API_IO_KEY is correct and valid. (Status: ${status})`;
        } else if (status === 400) {
            // 400 Bad Request often indicates an issue with the query syntax
           return `Error: Bad request. The search query "${query}" might be invalid or improperly formatted. Please check the query syntax. (Status: 400, Message: ${apiMessage})`;
        } else if (status === 404) {
            // While 404 usually means 'Not Found', in an API context it might be used differently.
            // However, the API docs suggest an empty array for no results, so a 404 might be a genuine endpoint issue.
           return `Error: API endpoint not found or unavailable. Please check the API configuration. (Status: 404)`;
        } else if (status === 429) {
          return `Error: API rate limit exceeded. Please wait and try again later. (Status: ${status})`;
        } else {
          return `Error: An API error occurred. Status: ${status || 'N/A'}, Message: ${apiMessage}`;
        }
      } else {
        return `Error: An unexpected error occurred while searching tweets: ${error.message}`;
      }
    }
  }
})

// --- Start the Agent Server ---
agent.start()
  .then(() => {
    const port = process.env.PORT || 7378;
    console.log(`Twitter Advanced Search Agent server started. Listening for requests on port ${port}`);
  })
  .catch(error => {
    console.error('Error starting agent server:', error)
  })
