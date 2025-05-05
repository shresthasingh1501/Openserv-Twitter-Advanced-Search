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
  systemPrompt: 'You are an agent designed to search for tweets using advanced query criteria (keywords, users, dates, etc.) via the twitter api. You can perform complex searches, including fetching subsequent pages of results using a cursor.',
  // apiKey: process.env.OPENSERV_API_KEY // SDK reads this automatically
})

// --- Add Capability for Advanced Search with Pagination ---
agent.addCapability({
  name: 'advancedTweetSearch',
  description: `Performs an advanced search for tweets based on a query string. Supports complex queries like keywords, hashtags, mentions, specific users (from:username), dates (since:YYYY-MM-DD, until:YYYY-MM-DD), etc. Returns the most recent matching tweets first (up to ~20 per call by default from the API). Supports pagination using a cursor. If more results are available, the output will include a 'next_cursor' value which can be provided in a subsequent call to retrieve the next page. Refer to Twitter's advanced search syntax for constructing queries. Example queries: '"artificial intelligence" from:elonmusk since:2023-01-01', '#opensource OR #AI', 'search term -exclude_word'.`,
  schema: z.object({
    query: z.string().describe(`The advanced search query string using Twitter's advanced search syntax (e.g., '"AI safety" from:openai', '#web3 since:2024-01-01', 'openserv.ai'). Required.`),
    queryType: z.enum(['Latest', 'Top']).default('Latest').describe('The type of search results to retrieve: "Latest" for most recent tweets, "Top" for most popular/relevant tweets. Defaults to "Latest".'),
    cursor: z.string().optional().describe('The cursor for pagination. Use the "next_cursor" value returned from a previous call to get the next page of results. Leave empty or omit for the first call/when not known.')
  }),
  async run({ args }) {
    // Destructure args including the optional cursor
    const { query, queryType, cursor } = args
    const apiUrl = `${twitterApiBaseUrl}/twitter/tweet/advanced_search`

    // Log the request details including the cursor
    console.log(`Performing advanced search with query: "${query}", type: ${queryType}, cursor: "${cursor || '(first page)'}" from ${apiUrl}`)

    try {
      const response = await axios.get(apiUrl, {
        params: {
          query: query,
          queryType: queryType,
          // Include the cursor parameter. If it's undefined/null/empty, pass an empty string as per API docs for the first page.
          cursor: cursor || ''
        },
        headers: {
          'X-API-Key': twitterApiKey,
          'Accept': 'application/json'
        }
      });

      // --- Handle API Response ---
      const responseData = response.data;

      // Check specifically for the presence of the 'tweets' array
      if (!responseData || !Array.isArray(responseData.tweets)) {
         const errorMessage = responseData?.message || responseData?.msg || 'Unknown API error or invalid data structure (missing tweets array).';
         console.error(`API returned unexpected data structure for query "${query}":`, errorMessage, responseData);
         return `Error: Failed to fetch tweets. API Response: ${errorMessage}`;
      }

      const tweetsArray = responseData.tweets;
      const hasNextPage = responseData.has_next_page; // Extract pagination info
      const nextCursor = responseData.next_cursor;    // Extract next cursor

      // Check if tweets array is empty for this specific page
      if (tweetsArray.length === 0) {
        // If it's the first page (no cursor provided), it means no results at all.
        // If it's a subsequent page, it just means this page is empty (end of results).
        const message = cursor
          ? `No more tweets found on this page for the query: "${query}".`
          : `No tweets found matching the search query: "${query}".`;
        console.log(message);
        // Include pagination info even if no tweets on *this* page, as API might still report next page (though unlikely)
        let output = message;
        if (hasNextPage && nextCursor) {
            output += `\n*Note: The API indicates more results might exist. Use this cursor for the next page: ${nextCursor}*`;
        } else {
            output += `\n*Note: End of results.*`;
        }
        return output;
      }

      // --- Format the Output ---
      let output = `**Search Results for Query "${query}" (Type: ${queryType}):**\n\n`;
      // Add note about which page this is if a cursor was used
      if (cursor) {
          output = `**Search Results for Query "${query}" (Type: ${queryType}) - Page corresponding to cursor "${cursor.substring(0,10)}...":**\n\n`;
      } else {
          output = `**Search Results for Query "${query}" (Type: ${queryType}) - First Page:**\n\n`;
      }


      tweetsArray.forEach((tweet: any, index: number) => {
        const authorUsername = tweet.author?.userName || 'Unknown User';
        // Ensure text exists before trying to access length or substring
        const tweetTextContent = tweet.text || '';
        const tweetText = tweetTextContent.substring(0, 250) + (tweetTextContent.length > 250 ? '...' : ''); // Truncate for brevity
        output += `${index + 1}. **Author:** @${authorUsername}\n`;
        output += `   **ID:** ${tweet.id}\n`;
        output += `   **Text:** ${tweetText}\n`;
        output += `   **Created:** ${tweet.createdAt}\n`;
        output += `   **Link:** ${tweet.url}\n`;
        output += `   **Stats:** Likes: ${tweet.likeCount || 0}, Retweets: ${tweet.retweetCount || 0}, Replies: ${tweet.replyCount || 0}, Views: ${tweet.viewCount || 0}\n\n`;
      });

       // --- Add pagination information to the output ---
       if (hasNextPage && nextCursor) {
         output += `\n*Note: More results available. Use this cursor for the next page: ${nextCursor}*\n`;
       } else {
         output += `\n*Note: End of results.*\n`;
       }

      const estimatedTokens = Math.ceil(output.length / 4);
      console.log(`Returning output with estimated ${estimatedTokens} tokens.`);

      // Keep total output limit check as safeguard
      const maxTotalOutputLength = 25000;
      if (output.length > maxTotalOutputLength) {
          console.warn(`Total output length ${output.length} exceeds safety limit ${maxTotalOutputLength}. Truncating further.`);
          output = output.substring(0, maxTotalOutputLength) + "\n... [Total output truncated due to length limit]";
      }

      return output;

    } catch (error: any) {
      console.error(`Error performing advanced search for query "${query}" with cursor "${cursor || ''}":`, error);

      // --- Handle HTTP/Network Errors ---
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const apiMessage = error.response?.data?.msg || error.response?.data?.message || 'No specific message from API.';
        if (status === 401 || status === 403) {
          return `Error: Authentication failed. Please check if the TWITTER_API_IO_KEY is correct and valid. (Status: ${status})`;
        } else if (status === 400) {
           // This could be an invalid query OR an invalid cursor
           const potentialReason = cursor ? `The search query "${query}" or the provided cursor might be invalid.` : `The search query "${query}" might be invalid or improperly formatted.`;
           return `Error: Bad request. ${potentialReason} Please check the query syntax and cursor value. (Status: 400, Message: ${apiMessage})`;
        } else if (status === 404) {
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
    console.log(`Agent ID: ${agent.agentId}`); // Log Agent ID for easy identification
    console.log('Capabilities:', agent.getCapabilities().map(c => c.name));
  })
  .catch(error => {
    console.error('Error starting agent server:', error)
  })
