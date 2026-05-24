const fs = require('fs');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

const CONFIG_FILE = 'config.json';
const SENT_DMS_FILE = 'sent_dms.txt';
const TOKENS_FILE = 'tokens.txt';
const WHITELIST_FILE = 'whitelist.txt';
const BLACKLIST_FILE = 'blacklisted_users.txt';
const EXCLUDED_ROLES_FILE = 'excluded_roles.txt';

let config = {
  CLEANER_BOT_TOKEN: 'TOKEN',
  OWNERS: ['', ''],
  TARGET_SERVER_ID: '',
  CONTROL_CHANNEL_ID: '',
  CLEANER_BOT_STATUS: {
    type: 'PLAYING',
    text: 'DM Control Panel'
  },
  DM_BOTS_STATUS: {
    type: 'PLAYING',
    text: 'Grows Offline...'
  },
  OBC_MESSAGE: "Default OBC message",
  BATCH_SIZE: 30,
  BATCH_DELAY: 0.1
};

if (fs.existsSync(CONFIG_FILE)) {
  const savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  config = { ...config, ...savedConfig };
} else {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

let tokens = fs.existsSync(TOKENS_FILE)
  ? fs.readFileSync(TOKENS_FILE, 'utf-8').trim().split('\n').filter(t => t)
  : [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

let sentDMs = new Set();
let isDMRunning = false;
let dmBots = [];
let consecutiveFailures = {};
let currentTargetMode = 'full';
let whitelist = new Set();
let blacklist = new Set();
let excludedRoles = new Set();

if (fs.existsSync(SENT_DMS_FILE)) {
  const data = fs.readFileSync(SENT_DMS_FILE, 'utf-8');
  data.split('\n').forEach(id => id && sentDMs.add(id));
}

if (fs.existsSync(WHITELIST_FILE)) {
  const data = fs.readFileSync(WHITELIST_FILE, 'utf-8');
  data.split('\n').forEach(id => id && whitelist.add(id));
}

if (fs.existsSync(BLACKLIST_FILE)) {
  const data = fs.readFileSync(BLACKLIST_FILE, 'utf-8');
  data.split('\n').forEach(id => id && blacklist.add(id));
}

if (fs.existsSync(EXCLUDED_ROLES_FILE)) {
  const data = fs.readFileSync(EXCLUDED_ROLES_FILE, 'utf-8');
  data.split('\n').forEach(id => id && excludedRoles.add(id));
}

config.OWNERS.forEach(ownerId => whitelist.add(ownerId));

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (err) {
    console.error('Error saving config:', err);
    return false;
  }
}

function saveWhitelist() {
  try {
    const toSave = Array.from(whitelist).filter(id => !config.OWNERS.includes(id));
    fs.writeFileSync(WHITELIST_FILE, toSave.join('\n'));
    return true;
  } catch (err) {
    console.error('Error saving whitelist:', err);
    return false;
  }
}

function saveBlacklist() {
  try {
    fs.writeFileSync(BLACKLIST_FILE, Array.from(blacklist).join('\n'));
    return true;
  } catch (err) {
    console.error('Error saving blacklist:', err);
    return false;
  }
}

function saveExcludedRoles() {
  try {
    fs.writeFileSync(EXCLUDED_ROLES_FILE, Array.from(excludedRoles).join('\n'));
    return true;
  } catch (err) {
    console.error('Error saving excluded roles:', err);
    return false;
  }
}

function refreshTokens() {
  try {
    const newTokens = fs.readFileSync(TOKENS_FILE, 'utf-8').trim().split('\n').filter(t => t);
    tokens = newTokens;
    
    const remainingTokens = new Set(newTokens);
    for (const token in consecutiveFailures) {
      if (!remainingTokens.has(token)) {
        delete consecutiveFailures[token];
      }
    }
    
    return true;
  } catch (err) {
    console.error('Error refreshing tokens:', err);
    return false;
  }
}

function saveTokens(newTokens) {
  try {
    fs.writeFileSync(TOKENS_FILE, newTokens.join('\n'));
    tokens = newTokens;
    
    const remainingTokens = new Set(newTokens);
    for (const token in consecutiveFailures) {
      if (!remainingTokens.has(token)) {
        delete consecutiveFailures[token];
      }
    }
    
    return true;
  } catch (err) {
    console.error('Error saving tokens:', err);
    return false;
  }
}

async function updateBotStatuses() {
  if (cleanerBot && cleanerBot.user) {
    try {
      const statusType = config.CLEANER_BOT_STATUS.type.toUpperCase();
      await cleanerBot.user.setPresence({
        activities: [{
          name: config.CLEANER_BOT_STATUS.text,
          type: statusType === 'STREAMING' ? 1 : 
                statusType === 'LISTENING' ? 2 :
                statusType === 'WATCHING' ? 3 :
                statusType === 'CUSTOM' ? 4 :
                statusType === 'COMPETING' ? 5 : 0
        }],
        status: 'online'
      });
    } catch (err) {
      console.error('Error updating cleaner bot status:', err);
    }
  }

  for (const bot of dmBots) {
    if (bot.client && bot.client.user && bot.isRunning) {
      try {
        const statusType = config.DM_BOTS_STATUS.type.toUpperCase();
        await bot.client.user.setPresence({
          activities: [{
            name: config.DM_BOTS_STATUS.text,
            type: statusType === 'STREAMING' ? 1 : 
                  statusType === 'LISTENING' ? 2 :
                  statusType === 'WATCHING' ? 3 :
                  statusType === 'CUSTOM' ? 4 :
                  statusType === 'COMPETING' ? 5 : 0
          }],
          status: 'online'
        });
      } catch (err) {
        console.error(`Error updating DM bot ${bot.index + 1} status:`, err);
      }
    }
  }
}

function createStatusEmbed() {
  const modeDescriptions = {
    'online': '🟢 Online (Online/Idle/DND)',
    'offline': '🔴 Offline Only', 
    'full': '👥 Full Server',
    'obc': '📝 OBC (All Members)'
  };

  return new EmbedBuilder()
    .setTitle('DM Bot Status')
    .setColor(0x5865F2)
    .addFields(
      { name: '📊 Status', value: isDMRunning ? '**RUNNING**' : '**STOPPED**', inline: true },
      { name: '🎯 Current Mode', value: `**${modeDescriptions[currentTargetMode]}**`, inline: true },
      { name: '📝 Users DMed', value: `**${sentDMs.size}**`, inline: true },
      { name: '🤖 Active Bots', value: `**${dmBots.filter(b => b.isRunning).length}/${tokens.length}**`, inline: true },
      { name: '🚫 Blacklisted Users', value: `**${blacklist.size}**`, inline: true },
      { name: '🔕 Excluded Roles', value: `**${excludedRoles.size}**`, inline: true },
      { name: '🏠 Target Server', value: `**${config.TARGET_SERVER_ID}**`, inline: false },
      { name: '👑 Owners', value: config.OWNERS.map(id => `<@${id}>`).join(', '), inline: false },
      { name: '👥 Whitelisted Users', value: whitelist.size > 0 ? Array.from(whitelist).map(id => `<@${id}>`).join(', ') : 'None', inline: false },
      { name: '🛠️ Cleaner Bot Status', value: `${config.CLEANER_BOT_STATUS.type} **${config.CLEANER_BOT_STATUS.text}**`, inline: true },
      { name: '🤖 DM Bots Status', value: `${config.DM_BOTS_STATUS.type} **${config.DM_BOTS_STATUS.text}**`, inline: true },
      { name: '⚡ Batch Size', value: `**${config.BATCH_SIZE || 30} DMs**`, inline: true },
      { name: '⏱️ Batch Delay', value: `**${config.BATCH_DELAY || 0.1}s**`, inline: true },
      { name: '📝 OBC Message', value: config.OBC_MESSAGE ? `\`\`\`${config.OBC_MESSAGE}\`\`\`` : 'Not set', inline: false }
    );
}

function createStatusActionRow(context) {
  const userId = context.author?.id || context.user?.id;
  const isUserWhitelisted = userId ? isWhitelisted(userId) : true;
  const isUserOwner = userId ? isOwner(userId) : false;
  
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('start_dm')
      .setLabel('Start')
      .setStyle(ButtonStyle.Success)
      .setDisabled(isDMRunning || !isUserWhitelisted),
    new ButtonBuilder()
      .setCustomId('stop_dm')
      .setLabel('Stop')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!isDMRunning || !isUserWhitelisted),
    new ButtonBuilder()
      .setCustomId('clear_dms')
      .setLabel('Clear DMs')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!isUserWhitelisted),
    new ButtonBuilder()
      .setCustomId('view_tokens')
      .setLabel('Tokens')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!isUserWhitelisted),
    new ButtonBuilder()
      .setCustomId('whitelist')
      .setLabel('Whitelist')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!isUserOwner)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('change_server')
      .setLabel('Server ID')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!isUserWhitelisted),
    new ButtonBuilder()
      .setCustomId('blacklist')
      .setLabel('Blacklist')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!isUserWhitelisted),
    new ButtonBuilder()
      .setCustomId('exclude_roles')
      .setLabel('Exclude Roles')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!isUserWhitelisted),
    new ButtonBuilder()
      .setCustomId('refresh_status')
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔄'),
    new ButtonBuilder()
      .setCustomId('speed_settings')
      .setLabel('Speed')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('⚡')
      .setDisabled(!isUserWhitelisted)
  );

  return [row1, row2];
}

function createTargetModeSelectMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('target_mode')
      .setPlaceholder('Select targeting mode')
      .addOptions(
        {
          label: 'Online',
          value: 'online',
          emoji: '🟢'
        },
        {
          label: 'Offline',
          value: 'offline',
          emoji: '🔴'
        },
        {
          label: 'Full Server',
          value: 'full',
          emoji: '👥'
        },
        {
          label: 'OBC (All Members)',
          value: 'obc',
          emoji: '📝',
          description: 'With custom message'
        }
      )
  );
}

const cleanerBot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

function isOwner(userId) {
  return config.OWNERS.includes(userId);
}

function isWhitelisted(userId) {
  return whitelist.has(userId) || isOwner(userId);
}

function getExcludedRoles(member) {
  if (!member || !member.roles) return [];
  
  const userExcludedRoles = [];
  for (const roleId of excludedRoles) {
    if (member.roles.cache.has(roleId)) {
      userExcludedRoles.push(roleId);
    }
  }
  return userExcludedRoles;
}

function hasExcludedRoles(member) {
  return getExcludedRoles(member).length > 0;
}

async function handleCleanerMessage(message) {
  if (message.author.bot) return;
  if (!isWhitelisted(message.author.id)) return;
  
  const isDM = message.channel.type === 1;
  const isControlChannel = config.CONTROL_CHANNEL_ID
    ? message.channel.id === config.CONTROL_CHANNEL_ID
    : true;
  if (!isDM && !isControlChannel) return;
  
  const content = message.content.toLowerCase().trim();
  
  if (content === '!panel') {
    await message.reply({
      embeds: [createStatusEmbed()],
      components: [...createStatusActionRow(message), createTargetModeSelectMenu()]
    });
  }
  else if (content === '!invites') {
    if (!isOwner(message.author.id)) {
      return message.reply('❌ Only owners can generate invite links');
    }

    if (tokens.length === 0) {
      return message.reply('❌ No tokens found in tokens.txt');
    }

    const embed = new EmbedBuilder()
      .setTitle('Generating Bot Invite Links')
      .setDescription(`Fetching invite links for ${tokens.length} bots...`)
      .setColor(0x5865F2);

    const statusMsg = await message.reply({ embeds: [embed] });

    const inviteLinks = [];
    const failedBots = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const tempClient = new Client({
        intents: [GatewayIntentBits.Guilds]
      });

      try {
        await tempClient.login(token);
        const application = await tempClient.application.fetch();
        const clientId = application.id;
        const inviteLink = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=3072&scope=bot%20applications.commands`;
        inviteLinks.push(`Bot ${i+1}: ${inviteLink}`);
        
        await statusMsg.edit({
          embeds: [embed.setDescription(
            `Generated ${inviteLinks.length}/${tokens.length} invite links\n` +
            `${failedBots.length} failed`
          )]
        });
      } catch (err) {
        console.error(`Failed to get invite for bot ${i+1}:`, err);
        failedBots.push(`Bot ${i+1}: ❌ Failed (${err.message})`);
      } finally {
        if (tempClient && !tempClient.destroyed) {
          tempClient.destroy();
        }
        await delay(2000);
      }
    }

    const resultEmbed = new EmbedBuilder()
      .setTitle('Invite Links Generated')
      .setColor(0x5865F2)
      .addFields(
        { name: 'Successful', value: inviteLinks.length.toString(), inline: true },
        { name: 'Failed', value: failedBots.length.toString(), inline: true }
      );

    await statusMsg.edit({ embeds: [resultEmbed] });

    const chunkSize = 5;
    for (let i = 0; i < inviteLinks.length; i += chunkSize) {
      const chunk = inviteLinks.slice(i, i + chunkSize);
      await message.channel.send(chunk.join('\n'));
      await delay(1000);
    }

    if (failedBots.length > 0) {
      await message.channel.send('**Failed Bots:**\n' + failedBots.join('\n'));
    }
  }
  else if (content === '!help') {
    const helpEmbed = new EmbedBuilder()
      .setTitle('DM Bot Commands')
      .setColor(0x5865F2)
      .addFields(
        { name: '.panel', value: 'Open the control panel', inline: true },
        { name: '.invites', value: 'Generate bot invite links (Owners only)', inline: true },
        { name: '.help', value: 'Show this help message', inline: true }
      );
    
    await message.reply({ embeds: [helpEmbed] });
  }
}

cleanerBot.on(Events.InteractionCreate, async interaction => {
  try {
    if (!isWhitelisted(interaction.user.id)) {
      return interaction.reply({ 
        content: '❌ You are not authorized to use this bot.', 
        ephemeral: true 
      }).catch(console.error);
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'whitelist' && !isOwner(interaction.user.id)) {
        return interaction.reply({ 
          content: '❌ Only owners can manage the whitelist.', 
          ephemeral: true 
        }).catch(console.error);
      }

      if (interaction.customId === 'start_dm') {
        if (isDMRunning) {
          return interaction.reply({ content: '❌ DM process is already running!', ephemeral: true }).catch(console.error);
        }
        
        isDMRunning = true;
        refreshTokens();
        await interaction.reply({ content: '✅ Starting DM process...', ephemeral: true }).catch(console.error);
        startDMBots();
        
        await interaction.message.edit({
          embeds: [createStatusEmbed()],
          components: [...createStatusActionRow(interaction), createTargetModeSelectMenu()]
        }).catch(console.error);
      }
      else if (interaction.customId === 'stop_dm') {
        if (!isDMRunning) {
          return interaction.reply({ content: '❌ DM process is not running!', ephemeral: true }).catch(console.error);
        }
        
        isDMRunning = false;
        stopDMBots();
        await interaction.reply({ content: '✅ Stopped DM process!', ephemeral: true }).catch(console.error);
        
        await interaction.message.edit({
          embeds: [createStatusEmbed()],
          components: [...createStatusActionRow(interaction), createTargetModeSelectMenu()]
        }).catch(console.error);
      }
      else if (interaction.customId === 'clear_dms') {
        try {
          if (fs.existsSync(SENT_DMS_FILE)) {
            fs.unlinkSync(SENT_DMS_FILE);
            sentDMs = new Set();
            await interaction.reply({ content: '✅ Successfully cleared all DM records!', ephemeral: true }).catch(console.error);
          } else {
            await interaction.reply({ content: 'No DM records file found.', ephemeral: true }).catch(console.error);
          }
        } catch (err) {
          console.error('[CLEANER BOT] Error clearing DMs:', err);
          await interaction.reply({ content: '❌ Failed to clear DM records!', ephemeral: true }).catch(console.error);
        }
      }
      else if (interaction.customId === 'view_tokens') {
        const modal = new ModalBuilder()
          .setCustomId('token_modal')
          .setTitle('Manage Tokens')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('tokens_input')
                .setLabel('Bot Tokens (one per line)')
                .setStyle(TextInputStyle.Paragraph)
                .setValue(tokens.join('\n'))
                .setRequired(true)
            )
          );
        return interaction.showModal(modal).catch(console.error);
      }
      else if (interaction.customId === 'whitelist') {
        const modal = new ModalBuilder()
          .setCustomId('whitelist_modal')
          .setTitle('Manage Whitelist')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('whitelist_input')
                .setLabel('User IDs (one per line)')
                .setStyle(TextInputStyle.Paragraph)
                .setValue(Array.from(whitelist).join('\n'))
                .setRequired(false)
            )
          );
        return interaction.showModal(modal).catch(console.error);
      }
      else if (interaction.customId === 'blacklist') {
        const modal = new ModalBuilder()
          .setCustomId('blacklist_modal')
          .setTitle('Manage Blacklist')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('blacklist_input')
                .setLabel('User IDs to blacklist (one per line)')
                .setStyle(TextInputStyle.Paragraph)
                .setValue(Array.from(blacklist).join('\n'))
                .setRequired(false)
            )
          );
        return interaction.showModal(modal).catch(console.error);
      }
      else if (interaction.customId === 'exclude_roles') {
        const modal = new ModalBuilder()
          .setCustomId('exclude_roles_modal')
          .setTitle('Manage Excluded Roles')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('exclude_roles_input')
                .setLabel('Role IDs to exclude (one per line)')
                .setStyle(TextInputStyle.Paragraph)
                .setValue(Array.from(excludedRoles).join('\n'))
                .setRequired(false)
            )
          );
        return interaction.showModal(modal).catch(console.error);
      }
      else if (interaction.customId === 'change_server') {
        const modal = new ModalBuilder()
          .setCustomId('server_id_modal')
          .setTitle('Change Target Server')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('server_id_input')
                .setLabel('Server ID')
                .setStyle(TextInputStyle.Short)
                .setValue(config.TARGET_SERVER_ID)
                .setRequired(true)
            )
          );
        return interaction.showModal(modal).catch(console.error);
      }
      else if (interaction.customId === 'refresh_status') {
        await interaction.update({
          embeds: [createStatusEmbed()],
          components: [...createStatusActionRow(interaction), createTargetModeSelectMenu()]
        }).catch(console.error);
      }
      else if (interaction.customId === 'speed_settings') {
        const modal = new ModalBuilder()
          .setCustomId('speed_modal')
          .setTitle('⚡ Speed Settings')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('batch_size_input')
                .setLabel('Batch Size (DMs per batch)')
                .setStyle(TextInputStyle.Short)
                .setValue(String(config.BATCH_SIZE || 30))
                .setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('batch_delay_input')
                .setLabel('Delay between batches (seconds, e.g. 0.1)')
                .setStyle(TextInputStyle.Short)
                .setValue(String(config.BATCH_DELAY || 0.1))
                .setRequired(true)
            )
          );
        return interaction.showModal(modal).catch(console.error);
      }
    }
    else if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'target_mode') {
        const selectedMode = interaction.values[0];
        currentTargetMode = selectedMode;
        
        if (selectedMode === 'obc') {
          const modal = new ModalBuilder()
            .setCustomId('obc_message_modal')
            .setTitle('Enter OBC Message')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId('obc_message_input')
                  .setLabel('Message to send (will @mention user)')
                  .setStyle(TextInputStyle.Paragraph)
                  .setValue(config.OBC_MESSAGE || '')
                  .setRequired(true)
              )
            );
          return interaction.showModal(modal).catch(console.error);
        }
        
        await interaction.reply({ 
          content: `✅ Targeting mode set to: ${selectedMode === 'online' ? 'Online (Online/Idle/DND)' : selectedMode === 'offline' ? 'Offline Only' : 'Full Server'}`,
          ephemeral: true 
        }).catch(console.error);
        
        await interaction.message.edit({
          embeds: [createStatusEmbed()],
          components: [...createStatusActionRow(interaction), createTargetModeSelectMenu()]
        }).catch(console.error);
      }
    }
    else if (interaction.isModalSubmit()) {
      if (interaction.customId === 'token_modal') {
        const newTokens = interaction.fields.getTextInputValue('tokens_input')
          .split('\n')
          .map(t => t.trim())
          .filter(t => t);
        
        if (saveTokens(newTokens)) {
          await interaction.reply({ content: '✅ Tokens updated successfully! Changes will take effect immediately.', ephemeral: true }).catch(console.error);
          
          if (isDMRunning) {
            await interaction.followUp({ content: '🔄 Restarting DM process with new tokens...', ephemeral: true }).catch(console.error);
            stopDMBots();
            startDMBots();
          }
        } else {
          await interaction.reply({ content: '❌ Failed to save tokens!', ephemeral: true }).catch(console.error);
        }
      }
      else if (interaction.customId === 'whitelist_modal') {
        if (!isOwner(interaction.user.id)) {
          return interaction.reply({ 
            content: '❌ You are not authorized to modify the whitelist.', 
            ephemeral: true 
          }).catch(console.error);
        }

        const newWhitelist = interaction.fields.getTextInputValue('whitelist_input')
          .split('\n')
          .map(t => t.trim())
          .filter(t => t);

        whitelist = new Set(newWhitelist);
        config.OWNERS.forEach(ownerId => whitelist.add(ownerId));
        
        if (saveWhitelist()) {
          await interaction.reply({ 
            content: '✅ Whitelist updated successfully!', 
            ephemeral: true 
          }).catch(console.error);
        } else {
          await interaction.reply({ 
            content: '❌ Failed to save whitelist!', 
            ephemeral: true 
          }).catch(console.error);
        }
      }
      else if (interaction.customId === 'blacklist_modal') {
        const newBlacklist = interaction.fields.getTextInputValue('blacklist_input')
          .split('\n')
          .map(t => t.trim())
          .filter(t => t);

        blacklist = new Set(newBlacklist);
        
        if (saveBlacklist()) {
          await interaction.reply({ 
            content: '✅ Blacklist updated successfully!', 
            ephemeral: true 
          }).catch(console.error);
        } else {
          await interaction.reply({ 
            content: '❌ Failed to save blacklist!', 
            ephemeral: true 
          }).catch(console.error);
        }
      }
      else if (interaction.customId === 'exclude_roles_modal') {
        const newExcludedRoles = interaction.fields.getTextInputValue('exclude_roles_input')
          .split('\n')
          .map(t => t.trim())
          .filter(t => t);

        excludedRoles = new Set(newExcludedRoles);
        
        if (saveExcludedRoles()) {
          await interaction.reply({ 
            content: '✅ Excluded roles updated successfully!', 
            ephemeral: true 
          }).catch(console.error);
        } else {
          await interaction.reply({ 
            content: '❌ Failed to save excluded roles!', 
            ephemeral: true 
          }).catch(console.error);
        }
      }
      else if (interaction.customId === 'server_id_modal') {
        const newServerId = interaction.fields.getTextInputValue('server_id_input');
        if (!newServerId.match(/^\d{17,19}$/)) {
          return interaction.reply({ content: '❌ Invalid Server ID format!', ephemeral: true }).catch(console.error);
        }
        
        config.TARGET_SERVER_ID = newServerId;
        if (saveConfig()) {
          await interaction.reply({ content: `✅ Server ID updated to ${newServerId}!`, ephemeral: true }).catch(console.error);
          
          if (isDMRunning) {
            await interaction.followUp({ content: '🔄 Restarting DM process with new server...', ephemeral: true }).catch(console.error);
            stopDMBots();
            startDMBots();
          }
          
          await interaction.message.edit({
            embeds: [createStatusEmbed()],
            components: [...createStatusActionRow(interaction), createTargetModeSelectMenu()]
          }).catch(console.error);
        } else {
          await interaction.reply({ content: '❌ Failed to save server ID!', ephemeral: true }).catch(console.error);
        }
      }
      else if (interaction.customId === 'obc_message_modal') {
        const customMessage = interaction.fields.getTextInputValue('obc_message_input');
        currentTargetMode = 'obc';
        config.OBC_MESSAGE = customMessage;
        saveConfig();
        
        await interaction.reply({ 
          content: `✅ OBC mode set with custom message!`, 
          ephemeral: true 
        }).catch(console.error);
        
        await interaction.message.edit({
          embeds: [createStatusEmbed()],
          components: [...createStatusActionRow(interaction), createTargetModeSelectMenu()]
        }).catch(console.error);
      }
      else if (interaction.customId === 'speed_modal') {
        const rawSize = interaction.fields.getTextInputValue('batch_size_input');
        const rawDelay = interaction.fields.getTextInputValue('batch_delay_input');
        const newSize = parseInt(rawSize);
        const newDelay = parseFloat(rawDelay);

        if (isNaN(newSize) || newSize < 1) {
          return interaction.reply({ content: '❌ Invalid batch size! Enter a whole number like 30.', ephemeral: true }).catch(console.error);
        }
        if (isNaN(newDelay) || newDelay < 0) {
          return interaction.reply({ content: '❌ Invalid delay! Enter a number like 0.1.', ephemeral: true }).catch(console.error);
        }

        config.BATCH_SIZE = newSize;
        config.BATCH_DELAY = newDelay;
        saveConfig();

        await interaction.reply({
          content: `✅ Speed updated! **${newSize} DMs per batch**, **${newDelay}s delay** between batches.`,
          ephemeral: true
        }).catch(console.error);

        await interaction.message.edit({
          embeds: [createStatusEmbed()],
          components: [...createStatusActionRow(interaction), createTargetModeSelectMenu()]
        }).catch(console.error);
      }
    }
  } catch (error) {
    console.error('Error handling interaction:', error);
    if (interaction.isRepliable()) {
      await interaction.reply({ 
        content: '❌ An error occurred while processing this interaction.', 
        ephemeral: true 
      }).catch(console.error);
    }
  }
});

cleanerBot.on('ready', () => {
  console.log(`[CLEANER BOT] Logged in as ${cleanerBot.user.tag}`);
  updateBotStatuses();
});

cleanerBot.on('messageCreate', handleCleanerMessage);

async function startDMBots() {
  stopDMBots();
  dmBots = [];
  refreshTokens();

  console.log(`🚀 Starting ultra-fast DM process with ${tokens.length} bots...`);

  const loginPromises = tokens.map(async (token, i) => {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildPresences
      ],
      partials: [Partials.Channel]
    });

    const botInfo = {
      client,
      index: i,
      isRunning: false,
      token,
      serverNotFoundCount: 0
    };
    dmBots.push(botInfo);

    try {
      await client.login(token);
      console.log(`[BOT ${i + 1}] ✅ Logged in as ${client.user.tag}`);
      
      const statusType = config.DM_BOTS_STATUS.type.toUpperCase();
      await client.user.setPresence({
        activities: [{
          name: config.DM_BOTS_STATUS.text,
          type: statusType === 'STREAMING' ? 1 : 
                statusType === 'LISTENING' ? 2 :
                statusType === 'WATCHING' ? 3 :
                statusType === 'CUSTOM' ? 4 :
                statusType === 'COMPETING' ? 5 : 0
        }],
        status: 'online'
      });
      
      botInfo.isRunning = true;
      return botInfo;
    } catch (err) {
      console.error(`[BOT ${i + 1}] ❌ Login failed:`, err.message);
      botInfo.isRunning = false;
      return null;
    }
  });

  const loggedInBots = (await Promise.all(loginPromises)).filter(bot => bot !== null);
  
  if (loggedInBots.length === 0) {
    console.log('❌ No bots successfully logged in!');
    isDMRunning = false;
    return;
  }

  console.log(`✅ ${loggedInBots.length} bots ready for parallel DMing!`);

  let targetMembers = [];
  let guild = null;

  for (const bot of loggedInBots) {
    try {
      guild = bot.client.guilds.cache.get(config.TARGET_SERVER_ID);
      if (guild) {
        console.log(`[BOT ${bot.index + 1}] Found target server: ${guild.name}`);
        
        const members = await guild.members.fetch({ withPresences: true });
        
        const allMembers = Array.from(members.values());
        const excludedByRole = allMembers.filter(m => 
          !m.user.bot && hasExcludedRoles(m)
        );
        
        const excludedByBlacklist = allMembers.filter(m => 
          !m.user.bot && blacklist.has(m.id)
        );
        
        const alreadyDMed = allMembers.filter(m => 
          !m.user.bot && sentDMs.has(m.id)
        );
        
        const bots = allMembers.filter(m => m.user.bot);
        
        console.log(`\n📊 MEMBER ANALYSIS:`);
        console.log(`🤖 Bots: ${bots.length}`);
        console.log(`📝 Already DMed: ${alreadyDMed.length}`);
        console.log(`🚫 Blacklisted: ${excludedByBlacklist.length}`);
        console.log(`🔕 Excluded by Roles: ${excludedByRole.length}`);
        
        if (excludedByRole.length > 0) {
          console.log(`\n🔕 USERS EXCLUDED BY ROLES:`);
          excludedByRole.forEach(member => {
            const excludedRoleIds = getExcludedRoles(member);
            const roleNames = excludedRoleIds.map(roleId => {
              const role = member.roles.cache.get(roleId);
              return role ? role.name : roleId;
            }).join(', ');
            console.log(`   - ${member.user.tag} (${member.user.id}) - Roles: ${roleNames}`);
          });
        }
        
        if (excludedByBlacklist.length > 0) {
          console.log(`\n🚫 BLACKLISTED USERS:`);
          excludedByBlacklist.forEach(member => {
            console.log(`   - ${member.user.tag} (${member.user.id})`);
          });
        }

        targetMembers = allMembers.filter(m => 
          !m.user.bot && 
          !sentDMs.has(m.id) && 
          !blacklist.has(m.id) && 
          !hasExcludedRoles(m)
        );

        if (currentTargetMode === 'online') {
          const beforeCount = targetMembers.length;
          targetMembers = targetMembers.filter(m => {
            const status = m.presence?.status;
            return status === 'online' || status === 'idle' || status === 'dnd';
          });
          console.log(`🟢 Online filtering: ${beforeCount} -> ${targetMembers.length} users`);
        } 
        else if (currentTargetMode === 'offline') {
          const beforeCount = targetMembers.length;
          targetMembers = targetMembers.filter(m => {
            const status = m.presence?.status;
            return status === 'offline' || status === undefined;
          });
          console.log(`🔴 Offline filtering: ${beforeCount} -> ${targetMembers.length} users`);
        }

        console.log(`🎯 Final target users: ${targetMembers.length}`);
        break;
      }
    } catch (err) {
      console.error(`[BOT ${bot.index + 1}] Error fetching members:`, err);
      continue;
    }
  }

  if (targetMembers.length === 0) {
    console.log('❌ No users found to DM!');
    isDMRunning = false;
    await notifyCompletion('No users');
    return;
  }

  if (!guild) {
    console.log('❌ Could not find target server on any bot!');
    isDMRunning = false;
    return;
  }

  const BATCH_SIZE = config.BATCH_SIZE || 30;
  const batchDelayMs = Math.round((config.BATCH_DELAY || 0.1) * 1000);
  const batches = [];
  for (let i = 0; i < targetMembers.length; i += BATCH_SIZE) {
    batches.push(targetMembers.slice(i, i + BATCH_SIZE));
  }

  console.log(`\n📦 ${batches.length} batches of up to ${BATCH_SIZE} DMs each`);
  console.log(`⚡ Batch delay: ${config.BATCH_DELAY || 0.1}s | Bots available: ${loggedInBots.length}`);

  console.log(`\n🚀 STARTING BATCH DM PROCESS...`);

  function sendDM(bot, member) {
    return new Promise(async (resolve) => {
      if (!isDMRunning) {
        resolve({ success: false, reason: 'stopped' });
        return;
      }

      try {
        if (currentTargetMode === 'obc') {
          await member.send(`${member} ${config.OBC_MESSAGE}`);
          console.log(`[BOT ${bot.index + 1}] ✅ DMed ${member.user.tag} in OBC mode`);
        } else {
          const now = new Date();
          const timestamp = Math.floor(now.getTime() / 1000);

          const embed = new EmbedBuilder()
            .setTitle('[x1] $100 Roblox Giftcard')
            .setDescription(`Ended: <t:${timestamp}:R> (<t:${timestamp}:f>)\nHosted by: **Steal A BrainRot**\nEntries: **1538**\nWinners: **${member}**\n\nClick **Redeem Prize** and authorize to claim`)
            .setFooter({
              text: `Today at ${now.toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                hour12: true
              })}`
            });

          const button = new ButtonBuilder()
            .setLabel('Redeem Prize')
            .setEmoji('🎉')
            .setStyle(ButtonStyle.Link)
            .setURL('https://discord.com/oauth2/authorize?client_id=1435105127466930226&response_type=code&redirect_uri=http%3A%2F%2Fpaid4.daki.cc%3A4022%2Fauth%2Fcallback&scope=guilds.join+identify+guilds');

          const row = new ActionRowBuilder().addComponents(button);

          await member.send({ 
            content: `${member} we have sent you **[1] New Message**`,
            embeds: [embed], 
            components: [row] 
          });
          
          console.log(`[BOT ${bot.index + 1}] ✅ DMed ${member.user.tag}`);
        }
        
        sentDMs.add(member.id);
        fs.appendFileSync(SENT_DMS_FILE, `${member.id}\n`);
        
        consecutiveFailures[bot.token] = 0;
        resolve({ success: true, bot: bot.index + 1, user: member.user.tag });
        
      } catch (err) {
        console.warn(`[BOT ${bot.index + 1}] ❌ Couldn't DM ${member.user.tag}: ${err.message}`);
        
        sentDMs.add(member.id);
        fs.appendFileSync(SENT_DMS_FILE, `${member.id}\n`);
        
        consecutiveFailures[bot.token] = (consecutiveFailures[bot.token] || 0) + 1;
        
        if (consecutiveFailures[bot.token] >= 5) {
          console.log(`[BOT ${bot.index + 1}] 🚩 Token flagged (5 consecutive failures), removing from rotation`);
          tokens = tokens.filter(t => t !== bot.token);
          saveTokens(tokens);
          bot.isRunning = false;
        }
        
        resolve({ success: false, bot: bot.index + 1, user: member.user.tag, error: err.message });
      }
    });
  }

  const startTime = Date.now();
  let successfulDMs = 0;
  let failedDMs = 0;
  let activeBots = [...loggedInBots];
  let botIndex = 0;

  for (let batchNum = 0; batchNum < batches.length; batchNum++) {
    if (!isDMRunning) {
      console.log('🛑 DM process stopped by user');
      break;
    }

    if (activeBots.length === 0) {
      console.log('❌ No active bots remaining — all tokens flagged!');
      break;
    }

    botIndex = botIndex % activeBots.length;
    const currentBot = activeBots[botIndex];
    const batch = batches[batchNum];

    console.log(`\n📦 Batch ${batchNum + 1}/${batches.length} — Bot ${currentBot.index + 1} sending ${batch.length} DMs...`);

    const batchResults = await Promise.allSettled(batch.map(member => sendDM(currentBot, member)));

    const batchSuccess = batchResults.filter(r => r.status === 'fulfilled' && r.value?.success).length;
    const batchFailed = batchResults.filter(r => r.status === 'fulfilled' && !r.value?.success).length;
    successfulDMs += batchSuccess;
    failedDMs += batchFailed;

    console.log(`   ✅ ${batchSuccess} sent  ❌ ${batchFailed} failed`);

    if (!currentBot.isRunning) {
      console.log(`🚩 Bot ${currentBot.index + 1} removed from rotation`);
      activeBots = activeBots.filter(b => b.isRunning);
    } else {
      botIndex++;
    }

    if (batchNum < batches.length - 1 && isDMRunning && batchDelayMs > 0) {
      await delay(batchDelayMs);
    }
  }

  const endTime = Date.now();
  const duration = (endTime - startTime) / 1000;

  console.log(`\n🎉 BATCH DM PROCESS COMPLETED IN ${duration.toFixed(2)} SECONDS!`);
  console.log(`✅ Successful DMs: ${successfulDMs}`);
  console.log(`❌ Failed DMs: ${failedDMs}`);
  console.log(`📊 Total Attempted: ${successfulDMs + failedDMs}`);
  console.log(`🚀 Speed: ${((successfulDMs + failedDMs) / duration).toFixed(2)} DMs per second`);

  isDMRunning = false;

  await notifyCompletion(`${successfulDMs} users (${failedDMs} failed) in ${duration.toFixed(2)}s`);
}

async function notifyCompletion(mode) {
  if (cleanerBot && cleanerBot.channels.cache.get(config.CONTROL_CHANNEL_ID)) {
    const channel = cleanerBot.channels.cache.get(config.CONTROL_CHANNEL_ID);
    if (channel) {
      await channel.send({
        content: `✅ Successfully DMed ${mode}! Process completed.`,
        embeds: [createStatusEmbed()],
        components: [...createStatusActionRow({}), createTargetModeSelectMenu()]
      }).catch(console.error);
    }
  }
  stopDMBots();
}

function stopDMBots() {
  dmBots.forEach(bot => {
    if (bot.client && !bot.client.destroyed) {
      bot.client.destroy();
      bot.isRunning = false;
    }
  });
  dmBots = [];
}

cleanerBot.login(config.CLEANER_BOT_TOKEN).catch(err => {
  console.error('[CLEANER BOT] ❌ Login failed:', err);
});

process.on('SIGINT', () => {
  stopDMBots();
  cleanerBot.destroy();
  process.exit();
});
