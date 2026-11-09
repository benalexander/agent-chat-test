Agent Chat POC

This project is to explore the viability (in the context of a fundraising campaign companion app) of 
a chat interface backed by an LLM. The agent should act as a supportive fundraising coach, responding
to user queries and offering encouragement when asked. It should also be possible for the agent to
be proactive and contact the user with ideas and news of the campaign.

The tech stack:

Expo/React Native - targeting iOS for this POC
Unistyles for styling
Cloudflare platform for the backend; workers, agents, durable objects

The chat history should be persisted in an agent of durable object, and synced to a local sqlite data store
If the agent initiates a conversation, a notification can be triggered, but rather than using a push notifiction
this could use a background task that periodically wakes and checks for new messages then schedules a local notification

This is a greenfield project
