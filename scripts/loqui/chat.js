'use strict';

var Chat = function (core, account) {

  // Holds only chat data and no functions
  this.core = core;
  this.core.unread = this.core.unread || 0;
  this.core.last = this.core.last || {};
  this.core.lastRead = 0;
  this.core.lastAck = 0;
  this.account = account;
  this.notification = undefined;
  
  // Render last chunk of messages
  this.lastChunkRender = function () {
    var ul = $('section#chat ul#messages');
    ul.empty();
    var index = this.core.chunks.length - 1;
    if (index >= 0) {
      this.chunkRender(index);
    }
  }
  
  // Render a chunk of messages
  this.chunkRender = function (index) {
    var chat = this;
    var ul = $('section#chat ul#messages');
    if (index >= 0 && ul.children('li[data-index="' + index + '"]').length < 1) {
      var stIndex = this.core.chunks[index];
      var height = ul[0].scrollHeight - ul[0].scrollTop;
      Store.recover(stIndex, function (chunk) {
        if (chunk) {
          var li = $('<li/>');
          var frag = document.createDocumentFragment();
          li.addClass('chunk');
          li.data('chunk', stIndex);
          li.data('index', index);
          var prevType, prevTime = null;
          for (var i in chunk) {
            var core = chunk[i];
            var msg = new Message(chat.account, core);
            var type = msg.core.from == chat.account.core.fullJid ? undefined : msg.core.from;
            var time = Tools.unstamp(msg.core.stamp);
            var timeDiff = time - prevTime;
            var avatarize = type && type != prevType;
            prevType = type;
            prevTime = time;
            if (timeDiff > 300000) {
              var conv = Tools.convenientDate(msg.core.stamp);
              frag.appendChild($('<time/>').attr('datetime', msg.core.stamp).text(_('DateTimeFormat', {date: conv[0], time: conv[1]}))[0]);
            }
            frag.appendChild(msg.preRender(i, avatarize));
          }
          li[0].appendChild(frag);
          var more = ul.children('.more');
          if (more.length) {
            more.replaceWith(li);
          } else {
            ul.prepend(li);
          }
          if (index > 0) {
            ul.prepend($('<button/>').addClass('more').html(_('MoreMessages', {number: App.defaults.Chat.chunkSize, total: index * App.defaults.Chat.chunkSize})).on('click', function (e) {
              chat.chunkRender(index - 1);
            }));
          }
          if (chunk.length < App.defaults.Chat.chunkSize / 2) {
            chat.chunkRender(index - 1);
          }
          ul[0].scrollTop += li.height() - 47;
        } else {
          chat.chunkRender(index - 1);
        }
        chat.account.avatarsRender();
      });
    }
  }
  
  // Push messages to this queue to append them to this chat
  this.messageAppend = async.queue(function (task, callback) {
    var msg = task.msg;
    var delay = task.delay;
    var chat = this;
    var chunkListSize = this.core.chunks.length;
    var blockIndex = this.core.chunks[chunkListSize - 1];
    var storageIndex;
    this.core.last = msg;
    if (chunkListSize > 0) {
      Store.recover(blockIndex, function (chunk) {
        if (!chunk || chunk.length >= App.defaults.Chat.chunkSize) {
          Tools.log('FULL OR NULL');
          var chunk = [msg];
          blockIndex = Store.save(chunk);
          Tools.log('PUSHING', blockIndex, chunk);
          chat.core.chunks.push(blockIndex);
          storageIndex = [blockIndex, 0];
          callback(blockIndex);
        } else {
          Tools.log('FITS');
          chunk.push(msg);
          blockIndex = chat.core.chunks[chunkListSize - 1];
          Tools.log('PUSHING', blockIndex, chunk);
          Store.update(blockIndex, chunk, callback);
          storageIndex = [blockIndex, chunk.length-1];
        }
        if (delay) {
          chat.account.toSendQ(storageIndex);
        }
      });
    } else {
      Tools.log('NEW');
      var chunk = [msg];
      blockIndex = Store.save(chunk);
      Tools.log('PUSHING', blockIndex, chunk);
      chat.core.chunks.push(blockIndex);
      storageIndex = [blockIndex, 0];
      if (delay) {
        chat.account.toSendQ(storageIndex);
      }
      callback(blockIndex);
    }
  }.bind(this));
  
  this.messageAppend.drain = function () {
    var chat = this;
    var pic = new Avatar(App.avatars[chat.core.jid]);
    var last = chat.core.last;
    if (chat.core.muc ? (chat.core.jid == last.to && (last.from != chat.account.core.user)) : (chat.core.jid == last.from)) {
      var callback = function () {
        chat.account.show();
        chat.show();
        App.toForeground();
      }
      var contact = Lungo.Core.findByProperty(chat.account.core.roster, 'jid', Strophe.getBareJidFromJid(last.from));
      var subject = (chat.core.muc && chat.core.unread < 2) ? ((contact ? (contact.name || last.pushName) : last.pushName) + ' @ ' + chat.core.title) : chat.core.title;
      var text = chat.core.unread > 1 ? _('NewMessages', {number: chat.core.unread}) : last.text;
      if (last.media) {
        var text = _('SentYou', {type: _('MediaType_' + last.media.type)});
      }
      if (chat.notification && 'close' in chat.notification) {
        chat.notification.close();
      }
      if (pic) {
        pic.url.then(function (src) {
          chat.notification = App.notify({ subject: subject, text: text, pic: src, callback: callback }, 'received');
        }.bind(chat));
      } else {
        chat.notification = App.notify({ subject: subject, text: text, pic: 'https://raw.github.com/loqui/im/master/img/foovatar.png', callback: callback }, 'received');
      }
    }
    this.save(true);
  }.bind(this);
  
  // Create a chat window for this contact
  this.show = function () {
    var section = $('section#chat');
    var header = section.children('header');
    section.data('jid', this.core.jid);
    section.data('features', $('section#main').data('features'));
    section.data('muc', this.core.muc || false);
    header.children('.title').html(App.emoji[Providers.data[this.account.core.provider].emoji].fy(this.core.title));
    section.find('#plus').removeClass('show');
    section.find('#typing').hide();
    section.find('#messages').empty();
    section.data('otr', 'OTR' in this);
    Lungo.Router.section('chat');
    var avatarize = function (url) {
      header.children('.avatar').children('img').attr('src', url);
    }
    if (App.avatars[this.core.jid]) {
      var existant = $('ul li[data-jid="' + this.core.jid + '"] .avatar img');
      if (existant.length) {
        avatarize(existant.attr('src'));
      } else {
        Store.recover(App.avatars[this.core.jid], function (val) {
          avatarize(val);
        });
      }
    } else {
      header.children('.avatar').children('img').attr('src', 'img/foovatar.png');
      var method = this.core.muc ? this.account.connector.groupAvatar : this.account.connector.avatar;
      method(function (a) {
        a.url.then(function (val) {
          avatarize(val);
        });
      }, this.core.jid);
    }
    setTimeout(function () {
      if (this.core.muc) {
        if (this.core.participants) {
          header.children('.status').text(_('NumParticipants', {number: this.core.participants.length}));
        } else {
          this.account.connector.groupParticipantsGet(this.core.jid);
          header.children('.status').text(' ');
        }
      } else {
        var contact = Lungo.Core.findByProperty(this.account.core.roster, 'jid', this.core.jid);
        var show = this.account.connector.isConnected() && contact ? (contact.presence.show || 'na') : 'na';
        var status = contact ? (contact.presence.status || _('show' + show)) : ' ';
        if (this.account.connector.presence.get) {
          this.account.connector.presence.get(this.core.jid);
        }
        header.children('.status').html(App.emoji[Providers.data[this.account.core.provider].emoji].fy(status));
        section.data('show', show);
      }
      this.lastChunkRender();
    }.bind(this), 500);
    if (this.core.unread) {
      this.account.unread -= this.core.unread;
      this.core.unread = 0;
      Accounts.unread();
    }
    this.core.lastRead = Tools.localize(Tools.stamp());
    this.save();
  }
  
  this.goOTR = function () {
    if (this.OTR.enabled) {
      this.OTR.buddy = new OTR({
        priv: this.OTR.key
      });    
    } else {
      
    }
  }
  
  // Save or update this chat in store
  this.save = function (up) {
    this.account.save();
    this.account.singleRender(this, up);
  }
    
}
