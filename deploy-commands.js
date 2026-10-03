require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder().setName('createkey').setDescription('Create a one-time license key')
    .addIntegerOption(o => o.setName('days').setDescription('How many days the key is valid for').setMinValue(1).setMaxValue(3650).setRequired(true))
    .addStringOption(o => o.setName('label').setDescription('Optional note, e.g. customer name').setMaxLength(80)),
  new SlashCommandBuilder().setName('keyinfo').setDescription('Show information about a license key')
    .addStringOption(o => o.setName('key').setDescription('License key').setRequired(true)),
  new SlashCommandBuilder().setName('disablekey').setDescription('Disable a license key')
    .addStringOption(o => o.setName('key').setDescription('License key').setRequired(true)),
  new SlashCommandBuilder().setName('enablekey').setDescription('Re-enable a license key')
    .addStringOption(o => o.setName('key').setDescription('License key').setRequired(true)),
  new SlashCommandBuilder().setName('resetkey').setDescription('Reset the key activation so it can be used again')
    .addStringOption(o => o.setName('key').setDescription('License key').setRequired(true)),
  new SlashCommandBuilder().setName('disableaccount').setDescription('Disable a username account')
    .addStringOption(o => o.setName('username').setDescription('Username').setRequired(true)),
  new SlashCommandBuilder().setName('enableaccount').setDescription('Enable a username account')
    .addStringOption(o => o.setName('username').setDescription('Username').setRequired(true)),
  new SlashCommandBuilder().setName('ping').setDescription('Check bot status')
].map(c => c.toJSON());

(async () => {
  const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
  if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) throw new Error('Fill DISCORD_TOKEN, CLIENT_ID, and GUILD_ID in .env');
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('Slash commands registered.');
})().catch(err => { console.error(err); process.exit(1); });
