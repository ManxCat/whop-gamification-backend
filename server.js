// server.js - Main Express Server for Whop Gamification App
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Whop Configuration
const WHOP_CONFIG = {
  clientId: process.env.WHOP_CLIENT_ID,
  clientSecret: process.env.WHOP_CLIENT_SECRET,
  redirectUri: process.env.WHOP_REDIRECT_URI,
  apiUrl: 'https://api.whop.com/v2'
};

// JWT Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';

// ==================== AUTHENTICATION ====================

// OAuth callback - Exchange code for access token
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    return res.status(400).json({ error: 'Authorization code missing' });
  }

  try {
    // Exchange code for access token
    const tokenResponse = await axios.post('https://api.whop.com/v2/oauth/token', {
      client_id: WHOP_CONFIG.clientId,
      client_secret: WHOP_CONFIG.clientSecret,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: WHOP_CONFIG.redirectUri
    });

    const { access_token, refresh_token } = tokenResponse.data;

    // Get user info from Whop
    const userResponse = await axios.get(`${WHOP_CONFIG.apiUrl}/me`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const whopUser = userResponse.data;

    // Check if user exists in our database
    let user = await pool.query(
      'SELECT * FROM users WHERE whop_user_id = $1',
      [whopUser.id]
    );

    if (user.rows.length === 0) {
      // Create new user
      const newUser = await pool.query(
        `INSERT INTO users (whop_user_id, username, email, access_token, refresh_token, level, xp, total_points, streak, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         RETURNING *`,
        [whopUser.id, whopUser.username, whopUser.email, access_token, refresh_token, 1, 0, 0, 0]
      );
      user = newUser;
      
      // Award "First Steps" achievement
      await awardAchievement(newUser.rows[0].id, 1, 100);
    } else {
      // Update existing user tokens
      await pool.query(
        'UPDATE users SET access_token = $1, refresh_token = $2, last_login = NOW() WHERE whop_user_id = $3',
        [access_token, refresh_token, whopUser.id]
      );
    }

    // Create JWT for our app
    const appToken = jwt.sign(
      { userId: user.rows[0].id, whopUserId: whopUser.id },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Redirect to frontend with token
    res.redirect(`${process.env.FRONTEND_URL}?token=${appToken}`);
  } catch (error) {
    console.error('OAuth error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// Middleware to verify JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// ==================== USER ENDPOINTS ====================

// Get current user profile
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.*, 
              COUNT(DISTINCT ua.achievement_id) as achievements_unlocked,
              (SELECT COUNT(*) FROM users WHERE total_points > u.total_points) + 1 as rank
       FROM users u
       LEFT JOIN user_achievements ua ON u.id = ua.user_id
       WHERE u.id = $1
       GROUP BY u.id`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    
    // Calculate XP to next level
    const xpToNextLevel = calculateXPForLevel(user.level + 1);

    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      level: user.level,
      xp: user.xp,
      xpToNextLevel: xpToNextLevel,
      totalPoints: user.total_points,
      streak: user.streak,
      rank: user.rank,
      achievements: user.achievements_unlocked,
      joinedDate: user.created_at
    });
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// ==================== TASKS ENDPOINTS ====================

// Get daily tasks for user
app.get('/api/tasks/daily', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT dt.*, ut.completed, ut.progress, ut.completed_at
       FROM daily_tasks dt
       LEFT JOIN user_tasks ut ON dt.id = ut.task_id AND ut.user_id = $1 
         AND DATE(ut.created_at) = CURRENT_DATE
       WHERE dt.active = true
       ORDER BY dt.id`,
      [req.user.userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching tasks:', error);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// Complete a task
app.post('/api/tasks/complete', authenticateToken, async (req, res) => {
  const { taskId } = req.body;

  try {
    // Get task details
    const taskResult = await pool.query(
      'SELECT * FROM daily_tasks WHERE id = $1',
      [taskId]
    );

    if (taskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = taskResult.rows[0];

    // Check if already completed today
    const existingTask = await pool.query(
      `SELECT * FROM user_tasks 
       WHERE user_id = $1 AND task_id = $2 AND DATE(created_at) = CURRENT_DATE`,
      [req.user.userId, taskId]
    );

    if (existingTask.rows.length > 0 && existingTask.rows[0].completed) {
      return res.status(400).json({ error: 'Task already completed today' });
    }

    // Mark task as completed
    await pool.query(
      `INSERT INTO user_tasks (user_id, task_id, completed, progress, completed_at, created_at)
       VALUES ($1, $2, true, $3, NOW(), NOW())
       ON CONFLICT (user_id, task_id, DATE(created_at))
       DO UPDATE SET completed = true, completed_at = NOW()`,
      [req.user.userId, taskId, task.required_count]
    );

    // Award XP
    await awardXP(req.user.userId, task.xp_reward);

    // Update streak
    await updateStreak(req.user.userId);

    res.json({ success: true, xpEarned: task.xp_reward });
  } catch (error) {
    console.error('Error completing task:', error);
    res.status(500).json({ error: 'Failed to complete task' });
  }
});

// ==================== ACHIEVEMENTS ENDPOINTS ====================

// Get all achievements with user progress
app.get('/api/achievements', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, 
              CASE WHEN ua.user_id IS NOT NULL THEN true ELSE false END as unlocked,
              ua.unlocked_at
       FROM achievements a
       LEFT JOIN user_achievements ua ON a.id = ua.achievement_id AND ua.user_id = $1
       ORDER BY a.category, a.id`,
      [req.user.userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching achievements:', error);
    res.status(500).json({ error: 'Failed to fetch achievements' });
  }
});

// ==================== LEADERBOARD ENDPOINTS ====================

// Get leaderboard
app.get('/api/leaderboard', authenticateToken, async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;

  try {
    const result = await pool.query(
      `SELECT 
        ROW_NUMBER() OVER (ORDER BY total_points DESC) as rank,
        id, username, total_points, level,
        CASE 
          WHEN ROW_NUMBER() OVER (ORDER BY total_points DESC) = 1 THEN '👑'
          WHEN ROW_NUMBER() OVER (ORDER BY total_points DESC) = 2 THEN '🥈'
          WHEN ROW_NUMBER() OVER (ORDER BY total_points DESC) = 3 THEN '🥉'
          ELSE '⭐'
        END as badge,
        CASE WHEN id = $1 THEN true ELSE false END as is_user
       FROM users
       ORDER BY total_points DESC
       LIMIT $2 OFFSET $3`,
      [req.user.userId, limit, offset]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// ==================== REWARDS ENDPOINTS ====================

// Get available rewards
app.get('/api/rewards', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, 
              CASE WHEN ur.user_id IS NOT NULL THEN true ELSE false END as redeemed,
              ur.redeemed_at
       FROM rewards r
       LEFT JOIN user_rewards ur ON r.id = ur.reward_id AND ur.user_id = $1
       WHERE r.active = true
       ORDER BY r.cost`,
      [req.user.userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching rewards:', error);
    res.status(500).json({ error: 'Failed to fetch rewards' });
  }
});

// Redeem a reward
app.post('/api/rewards/redeem', authenticateToken, async (req, res) => {
  const { rewardId } = req.body;

  try {
    // Get reward details
    const rewardResult = await pool.query(
      'SELECT * FROM rewards WHERE id = $1 AND active = true',
      [rewardId]
    );

    if (rewardResult.rows.length === 0) {
      return res.status(404).json({ error: 'Reward not found' });
    }

    const reward = rewardResult.rows[0];

    // Get user points
    const userResult = await pool.query(
      'SELECT total_points FROM users WHERE id = $1',
      [req.user.userId]
    );

    const user = userResult.rows[0];

    if (user.total_points < reward.cost) {
      return res.status(400).json({ error: 'Insufficient points' });
    }

    // Deduct points
    await pool.query(
      'UPDATE users SET total_points = total_points - $1 WHERE id = $2',
      [reward.cost, req.user.userId]
    );

    // Record redemption
    await pool.query(
      'INSERT INTO user_rewards (user_id, reward_id, redeemed_at) VALUES ($1, $2, NOW())',
      [req.user.userId, rewardId]
    );

    // TODO: Trigger reward fulfillment (send email, grant Discord role, etc.)

    res.json({ success: true, message: 'Reward redeemed successfully' });
  } catch (error) {
    console.error('Error redeeming reward:', error);
    res.status(500).json({ error: 'Failed to redeem reward' });
  }
});

// ==================== ACTIVITY ENDPOINTS ====================

// Get user activity feed
app.get('/api/activity', authenticateToken, async (req, res) => {
  const { limit = 20 } = req.query;

  try {
    const result = await pool.query(
      `SELECT activity_type, description, xp_earned, created_at
       FROM activity_log
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [req.user.userId, limit]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching activity:', error);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

// ==================== WHOP WEBHOOKS ====================

// Handle Whop webhooks
app.post('/webhooks/whop', async (req, res) => {
  const event = req.body;

  try {
    // Verify webhook signature (implement this in production)
    // const signature = req.headers['x-whop-signature'];
    // if (!verifyWhopSignature(signature, req.body)) {
    //   return res.status(401).json({ error: 'Invalid signature' });
    // }

    switch (event.type) {
      case 'message.created':
        await handleMessageCreated(event.data);
        break;
      case 'post.created':
        await handlePostCreated(event.data);
        break;
      case 'reaction.added':
        await handleReactionAdded(event.data);
        break;
      case 'member.joined':
        await handleMemberJoined(event.data);
        break;
      default:
        console.log('Unhandled webhook event:', event.type);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ==================== HELPER FUNCTIONS ====================

// Award XP to user and check for level up
async function awardXP(userId, xp) {
  const userResult = await pool.query(
    'SELECT level, xp, total_points FROM users WHERE id = $1',
    [userId]
  );
  
  const user = userResult.rows[0];
  const newXP = user.xp + xp;
  const newPoints = user.total_points + xp;
  
  // Check for level up
  const xpNeeded = calculateXPForLevel(user.level + 1);
  let newLevel = user.level;
  let remainingXP = newXP;
  
  if (newXP >= xpNeeded) {
    newLevel = user.level + 1;
    remainingXP = newXP - xpNeeded;
    
    // Log level up
    await logActivity(userId, 'level_up', `Reached Level ${newLevel}`, 1000);
  }
  
  await pool.query(
    'UPDATE users SET xp = $1, level = $2, total_points = $3 WHERE id = $4',
    [remainingXP, newLevel, newPoints, userId]
  );
  
  return { newLevel, newXP: remainingXP, leveledUp: newLevel > user.level };
}

// Award achievement to user
async function awardAchievement(userId, achievementId, xp) {
  const existing = await pool.query(
    'SELECT * FROM user_achievements WHERE user_id = $1 AND achievement_id = $2',
    [userId, achievementId]
  );
  
  if (existing.rows.length > 0) return;
  
  await pool.query(
    'INSERT INTO user_achievements (user_id, achievement_id, unlocked_at) VALUES ($1, $2, NOW())',
    [userId, achievementId]
  );
  
  await awardXP(userId, xp);
  await logActivity(userId, 'achievement', `Unlocked achievement`, xp);
}

// Update user streak
async function updateStreak(userId) {
  const result = await pool.query(
    'SELECT last_activity, streak FROM users WHERE id = $1',
    [userId]
  );
  
  const user = result.rows[0];
  const lastActivity = new Date(user.last_activity);
  const today = new Date();
  const daysDiff = Math.floor((today - lastActivity) / (1000 * 60 * 60 * 24));
  
  let newStreak = user.streak;
  
  if (daysDiff === 1) {
    // Continue streak
    newStreak = user.streak + 1;
  } else if (daysDiff > 1) {
    // Streak broken
    newStreak = 1;
  }
  
  await pool.query(
    'UPDATE users SET last_activity = NOW(), streak = $1 WHERE id = $2',
    [newStreak, userId]
  );
  
  // Check for streak achievements
  if (newStreak === 7) {
    await awardAchievement(userId, 3, 500); // Week Warrior
  } else if (newStreak === 30) {
    await awardAchievement(userId, 6, 1000); // Month Master
  }
}

// Calculate XP needed for a level
function calculateXPForLevel(level) {
  return Math.floor(100 * Math.pow(1.5, level - 1));
}

// Log activity
async function logActivity(userId, activityType, description, xpEarned) {
  await pool.query(
    'INSERT INTO activity_log (user_id, activity_type, description, xp_earned, created_at) VALUES ($1, $2, $3, $4, NOW())',
    [userId, activityType, description, xpEarned]
  );
}

// Webhook handlers
async function handleMessageCreated(data) {
  const user = await getUserByWhopId(data.user_id);
  if (!user) return;
  
  await awardXP(user.id, 10);
  await checkMessageAchievements(user.id);
}

async function handlePostCreated(data) {
  const user = await getUserByWhopId(data.user_id);
  if (!user) return;
  
  await awardXP(user.id, 50);
  await checkPostAchievements(user.id);
}

async function handleReactionAdded(data) {
  const user = await getUserByWhopId(data.user_id);
  if (!user) return;
  
  await awardXP(user.id, 5);
}

async function handleMemberJoined(data) {
  // New member joined - already handled in OAuth callback
}

async function getUserByWhopId(whopUserId) {
  const result = await pool.query(
    'SELECT * FROM users WHERE whop_user_id = $1',
    [whopUserId]
  );
  return result.rows[0];
}

async function checkMessageAchievements(userId) {
  // Check if user sent 50 messages
  const count = await pool.query(
    `SELECT COUNT(*) FROM activity_log 
     WHERE user_id = $1 AND activity_type = 'message'`,
    [userId]
  );
  
  if (count.rows[0].count >= 50) {
    await awardAchievement(userId, 2, 250); // Chatterbox
  }
}

async function checkPostAchievements(userId) {
  // Check if user created 25 posts
  const count = await pool.query(
    `SELECT COUNT(*) FROM activity_log 
     WHERE user_id = $1 AND activity_type = 'post'`,
    [userId]
  );
  
  if (count.rows[0].count >= 25) {
    await awardAchievement(userId, 5, 750); // Content King
  }
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Whop Gamification API running on port ${PORT}`);
