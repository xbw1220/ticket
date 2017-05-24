const _ = require('lodash')
const AV = require('leanengine')

const common = require('./common')
const TICKET_STATUS = require('../lib/constant').TICKET_STATUS
const errorHandler = require('./errorHandler')
const notify = require('./notify')

AV.Cloud.beforeSave('Ticket', (req, res) => {
  if (!req.currentUser._sessionToken) {
    return res.error('noLogin')
  }
  req.object.set('status', TICKET_STATUS.NEW)
  getTicketAcl(req.object, req.currentUser).then((acl) => {
    req.object.setACL(acl)
    req.object.set('author', req.currentUser)
    return selectAssignee(req.object)
  }).then((assignee) => {
    req.object.set('assignee', assignee)
    res.success()
  }).catch(errorHandler.captureException)
})

const getTicketAcl = (ticket, author) => {
  const acl = new AV.ACL()
  acl.setWriteAccess(author, true)
  acl.setReadAccess(author, true)
  acl.setRoleWriteAccess(new AV.Role('customerService'), true)
  acl.setRoleReadAccess(new AV.Role('customerService'), true)
  return Promise.resolve(acl)
}

AV.Cloud.afterSave('Ticket', (req) => {
  req.object.get('assignee').fetch()
  .then((assignee) => {
    return common.getTinyUserInfo(assignee)
    .then((assigneeInfo) => {
      return new AV.Object('OpsLog').save({
        ticket: req.object,
        action: 'selectAssignee',
        data: {assignee: assigneeInfo},
      }, {useMasterKey: true})
    })
    .then(() => {
      return notify.newTicket(req.object, req.currentUser, assignee)
    })
  }).catch(errorHandler.captureException)
})

AV.Cloud.afterUpdate('Ticket', (req) => {
  common.getTinyUserInfo(req.currentUser).then((user) => {
    if (req.object.updatedKeys.indexOf('status') != -1) {
      new AV.Object('OpsLog').save({
        ticket: req.object,
        action: 'changeStatus',
        data: {status: req.object.get('status'), operator: user},
      }, {useMasterKey: true})
    }
    if (req.object.updatedKeys.indexOf('category') != -1) {
      new AV.Object('OpsLog').save({
        ticket: req.object,
        action: 'changeCategory',
        data: {category: req.object.get('category'), operator: user},
      }, {useMasterKey: true})
    }
    if (req.object.updatedKeys.indexOf('assignee') != -1) {
      common.getTinyUserInfo(req.object.get('assignee')).then((assignee) => {
        new AV.Object('OpsLog').save({
          ticket: req.object,
          action: 'changeAssignee',
          data: {assignee: assignee, operator: user},
        }, {useMasterKey: true})
      })
    }
  })
})

AV.Cloud.define('getTicketAndRepliesView', (req, res) => {
  return new AV.Query('Ticket')
  .equalTo('nid', req.params.nid)
  .include('author')
  .include('files')
  .first({user: req.currentUser})
  .then(ticket => {
    if (!ticket) {
      return res.error('notFound')
    }
    ticket.set('contentHtml', common.md.render(ticket.get('content')))
    return new AV.Query('Reply')
    .equalTo('ticket', ticket)
    .include('author')
    .include('files')
    .find({user: req.currentUser})
    .then(replies => {
      replies = replies.map(reply => {
        reply.set('contentHtml', common.md.render(reply.get('content')))
        return reply.toFullJSON()
      })
      return res.success({ticket: ticket.toFullJSON(), replies})
    })
  }).catch(console.error)
})

const selectAssignee = (ticket) => {
  return new AV.Query(AV.Role)
  .equalTo('name', 'customerService')
  .first()
  .then((role) => {
    const category = ticket.get('category')
    const query = role.getUsers().query()
    if (!_.isEmpty(category)) {
      query.equalTo('categories.objectId', category.objectId)
    }
    return query.find({useMasterKey: true}).then((users) => {
      if (users.length != 0) {
        return _.sample(users)
      }
      return role.getUsers().query().find({useMasterKey: true}).then(_.sample)
    })
  })
}

