import _ from "lodash";

import { redisClient } from "../utils";
import models from "../models";

export default {
  create: async (req, res) => {
    try {
      // req.user is retreived from bearer token of auth.policy
      const currentUserId = req.user.id;
      const {
        teamId,
        channelName,
        isPublic,
        detail_description,
        membersList,
        messageGroup
      } = req.body;
      const member = await models.TeamMember.findOne(
        { where: { teamId, userId: currentUserId } },
        { raw: true }
      );
      const response = await models.sequelize.transaction(async transaction => {
        let channel;

        /*  check if it's message group */
        if (!messageGroup) {
          channel = await models.Channel.create(
            {
              name: channelName,
              detail_description,
              public: isPublic,
              teamId
            },
            { transaction }
          );
        }
        if (messageGroup) {
          /* check if message group already created between requested members */
          const allMembers = [...membersList, currentUserId];
          const [data, result] = await models.sequelize.query(
            `
          select c.id, c.name
          from channels as c, channel_members cm
          where cm.channel_id = c.id and c.message_group = true and c.public = false and c.team_id = ${teamId}
          group by c.id, c.name
          having array_agg(cm.user_id) @> Array[${allMembers.join(
            ","
          )}] and count(cm.user_id) = ${allMembers.length};
          `,
            { raw: true }
          );

          /* message group already exist, respond with error */
          if (data.length) {
            return res.status(403).send({
              meta: {
                type: "error",
                status: 403,
                message:
                  "direct message between members has already been created"
              }
            });
          }

          /* conditions are validated, create the message group */
          channel = await models.Channel.create(
            {
              name: channelName,
              public: isPublic,
              detail_description,
              messageGroup: true,
              teamId
            },
            { transaction }
          );
        }

        /*  check if it's private channel */
        if (!isPublic) {
          /*  filter out private channel members */
          const members = membersList.filter(
            memberId => memberId !== currentUserId
          );
          members.push(currentUserId);
          const ChannelMembers = members.map(memberId => ({
            userId: memberId,
            channelId: channel.dataValues.id
          }));
          /* create channel member relation for private member */
          await models.ChannelMember.bulkCreate(ChannelMembers, {
            transaction
          });

          /*  return channel created and private channel members */
          return { channel, channelMemberList: ChannelMembers };
        }

        /* create channel member relation for public member */
        const teamMemberList = await models.sequelize.query(
          "select * from users as u join team_members as m on m.user_id = u.id where m.team_id = ?",
          {
            replacements: [teamId],
            model: models.User,
            raw: true
          }
        );
        const channelMemberIdList = teamMemberList.map(m => ({
          userId: m.id,
          channelId: channel.dataValues.id
        }));
        await models.ChannelMember.bulkCreate(channelMemberIdList, {
          transaction
        });

        /* return channel created and public channel members */
        return {
          channel: channel.dataValues,
          channelMemberList: teamMemberList
        };
      });

      const channelList = await models.sequelize.query(
        `
          select distinct on (id) *
          from channels as c left outer join channel_members as pcm
          on c.id = pcm.channel_id
          where c.team_id = :teamId and (c.public = true or pcm.user_id = :userId);`,
        {
          replacements: { teamId, userId: currentUserId },
          model: models.Channel,
          raw: true
        }
      );

      res.status(200).send({
        meta: {
          type: "sucesss",
          status: 200,
          message: ""
        },
        channelList,
        channel: response.channel,
        channelMemberList: response.channelMemberList
      });
    } catch (err) {
      console.log(err);
      res.status(500).send({
        meta: {
          type: "error",
          status: 500,
          message: "server error"
        }
      });
    }
  },
  getChannelAssociatedList: async (req, res) => {
    try {
      /*  req.user is retreived from bearer token of auth.policy */
      const currentUserId = req.user.id;
      const { channelId } = req.params;

      // check if redis has the data
      const messagelListCache = await redisClient.getAsync(
        `messageList:${channelId}`
      );
      const channelMemberListCache = await redisClient.getAsync(
        `channelMemberList:${channelId}`
      );
      if (messagelListCache && channelMemberListCache) {
        const messagelListCacheArr = _.toArray(JSON.parse(messagelListCache));

        const channelMemberListCacheArr = _.toArray(
          JSON.parse(channelMemberListCache)
        );

        return res.status(200).send({
          meta: {
            type: "success",
            status: 200,
            message: ""
          },
          messageList: messagelListCacheArr.reverse(),
          channelMemberList: channelMemberListCacheArr
        });
      }

      /* find channel user request to get message */
      const channel = await models.Channel.findOne({
        raw: true,
        where: { id: channelId }
      });
      const messageList = await models.Message.findAll(
        {
          order: [["created_at", "DESC"]],
          where: { channelId },
          limit: 30,
          offset: 0
        },
        { raw: true }
      );

      /* check if channel is private */
      if (!channel.public) {
        /* check if user is member of private channel */
        const member = await models.ChannelMember.findOne({
          raw: true,
          where: { channelId, userId: currentUserId }
        });
        /* return error if user is not member */
        if (!member) {
          return res.status(403).send({
            meta: {
              type: "error",
              status: 403,
              message: "you are not member of the private channel"
            }
          });
        }
        /*  get private channel member list */
        const channelMemberList = await models.sequelize.query(
          "select * from users as u join channel_members as pcm on pcm.user_id = u.id where pcm.channel_id = ?",
          {
            replacements: [channelId],
            model: models.User,
            raw: true
          }
        );

        /*  return channel's messages and channel private member list */
        return res.status(200).send({
          meta: {
            type: "success",
            status: 200,
            message: ""
          },
          messageList: messageList.reverse(),
          channelMemberList
        });
      }

      /*  return channel's messages and channel public member list */
      const channelMemberList = await models.sequelize.query(
        "select * from users as u join channel_members as cm on cm.user_id = u.id where cm.channel_id = ?",
        {
          replacements: [channelId],
          model: models.User,
          raw: true
        }
      );

      // Save the responses in Redis store
      await redisClient.setex(
        `messageList:${channelId}`,
        86400, // 60 * 60 * 24 seconds
        JSON.stringify({ source: "Redis Cache", ...messageList })
      );
      // Save the responses in Redis store
      await redisClient.setex(
        `channelMemberList:${channelId}`,
        86400, // 60 * 60 * 24 seconds
        JSON.stringify({ source: "Redis Cache", ...channelMemberList })
      );

      res.status(200).send({
        meta: {
          type: "success",
          status: 200,
          message: ""
        },
        messageList: messageList.reverse(),
        channelMemberList
      });
    } catch (err) {
      console.log(err);
      res.status(500).send({
        meta: {
          type: "error",
          status: 500,
          message: "server error"
        }
      });
    }
  }
};
