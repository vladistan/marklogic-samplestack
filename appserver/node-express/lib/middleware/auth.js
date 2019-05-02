/* 
 * Copyright 2012-2015 MarkLogic Corporation 
 * 
 * Licensed under the Apache License, Version 2.0 (the "License"); 
 * you may not use this file except in compliance with the License. 
 * You may obtain a copy of the License at 
 * 
 *    http://www.apache.org/licenses/LICENSE-2.0 
 * 
 * Unless required by applicable law or agreed to in writing, software 
 * distributed under the License is distributed on an "AS IS" BASIS, 
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. 
 * See the License for the specific language governing permissions and 
 * limitations under the License. 
 */ 

var options = sharedRequire('js/options');

var passport = require('passport');
var ldapauth = require('passport-ldapauth');
var cookieSession = require('cookie-session');
var async = require('async');
var csrf = require('csurf');
var util = require('util');
var dbClient = libRequire('db-client');
var mon = libRequire('monitoring');

// TODO: serialize to-from server
var users = {};


var handleCsrfError = function (err, req, res, next) {
  if (err.code !== 'EBADCSRFTOKEN') {
    return next(err);
  }
  res.status(400).send({error: 'Invalid CSRF token.'});
};

/**
 * Error handlers associated with this module.
 * @type {Array}
 */
/**
 * If enabled, generates a CSRF token, stores it to the session (TODO), and
 * sets the response HEADER.
 *
 * @param {Object}   req
 * @param {Object}   res
 * @param {Function} next
 */
var setCsrfHeader = function (req, res, next) {
  if (options.middleTier.enableCsrf) {
    try {
      csrf()(req, res, function () {});
    }
    // expect failure, csurf needs work here, they don't let you
    // cleanly generate a token ATM
    catch (err) {}
    req.user.token = req.csrfToken();
    res.set('X-CSRF-Token', req.user.token);
  }
  next();
};

/**
 * When this is called, we only do something if BOTH:
 * a) CSRF protection is enabled in the options file; and
 * b) the request is associated with a session
 *
 * In other words, we allow people to proceed without CSRF if they
 * do not even claim to have a session, or if we aren't intending to
 * enforce CSRF. Otherwise, they must pass the CSRF token test.
 * (The token must have been stored in the session data for this to work.)
 * TODO:
 * a) revive session data if the user comes in with a sessionid
 * b) set the server-side token in memory to match the revived session data
 * c) store token in session data as part of auth. mechanism
 * d) throw out sessions when a bad request comes in (not found token or
 * CSRF mismatch)
 *
 * @param {Object}   req
 * @param {Object}   res
 * @param {Function} next
 */
var checkCsrfHeader = function (req, res, next) {
  if (options.middleTier.enableCsrf && req.session) {
    csrf()(req, res, next);
  }
  else {
    next();
  }
};

var useRole = function (role, req) {
  req.role = role;
  var user = options.middleTier.rolesMap[role].dbUser;
  var password = options.middleTier.rolesMap[role].dbPassword;
  var db = dbClient.getBoundClient(user, password);
  req.db = db;

};

var pickRole = function (roles, req, res, next) {
  // a request is made by someone with roles.
  // the fallback role is "default", so we tack that on to the end of
  // the requestor's list
  var userRoles = req.user ?
      _.clone(req.user.roles) :
      [];
  userRoles.push('default');
  var roleChoice;

  // from among the roles that we may assign for this request, choose the
  // first that the requestor actually has
  _.each(roles, function (desiredRole) {
    var testIndex = userRoles.indexOf(desiredRole);
    if (testIndex > -1) {
      roleChoice = userRoles[testIndex];
      return false;
    }
  });
  if (roleChoice) {
    // if we found a matching role, assign it and get the database connection
    // that matches
    useRole(roleChoice, req);

    next();
  }
  else {
    // if we don't have a matching role and we already know who the user
    // is, it's a 403
    if (req.user) {
      res.status(403).send({ message: 'Forbidden' });
    }
    // if we don't have a matching role and we don't even have
    // a session, then it's a 401
    else {
      res.status(401).send({ message: 'Unauthorized' });
    }
  }
};

var configurePassport = function (app , ldapConfig) {
  var ldapOptions = options.middleTier.ldap;

  passport.use(new ldapauth.Strategy(

    {
      passReqToCallback: true,
      usernameField: 'username',
      passwordField: 'password',
      server : {
        url: ldapOptions.protocol +
            '://' + ldapOptions.hostname +
            ':' + ldapOptions.port,
        bindDn: ldapOptions.adminDn,
        bindCredentials: ldapOptions.adminPassword,
        searchBase: ldapOptions.searchBase,
        searchFilter: ldapOptions.searchFilter,
      }
    },
    function (req, user, done) {
      if (!_.isArray(user.role)) {
        user.role = [user.role];
      }
      user.roles = _.reduce(user.role, function (role, ldapEntry) {
        var cn = ldapEntry.split(',')[0].split('=')[1];
        role.push(cn);
        return role;
      }, []);

      useRole(['default'], req);
      req.db.contributor.getUniqueContent(null, { userName: user.uid })
      .then(function (contributor) {
        user = {
          id: contributor.id,
          roles: user.roles,
          displayName: contributor.displayName,
        };

        // stuff this on the request so we can reply nicely
        contributor.role = user.roles;
        req.contributor = contributor;

        return done(null, user);
      })
      .catch(done);
    }
  ));


  passport.serializeUser(function (user, done) {
    done(null, user);
  });

  passport.deserializeUser(function (user, done) {
    done(null, user);
  });

  var sessionModule = require('express-session');
  var MarkLogicStore = require('connect-marklogic')(sessionModule);


  var expressSession = sessionModule({

    // TODO: move credentials into options
    store: new MarkLogicStore({
      client: dbClient.getGenericClient('admin', 'admin')
    }),
    secret: '<mysecret>',

    // this is here so that a successful
    // GET /v1/session will always make a connect.sid cookie
    saveUninitialized: true,

    // if you are timing out unused sessions, you probably want this to be
    // true so that you don't keep touching the timestamp of your document
    resave: false
  });


  return {
    // TODO: this isn't overwriting previous sessions!!!!!!
    createSession: expressSession,
    loginSession: function (req, res, next) {
      async.waterfall([
        expressSession.bind(this, req, res),
        passport.initialize().bind(passport, req, res),
        passport.session().bind(passport, req, res),
        passport.authenticate('ldapauth').bind(passport, req, res)
      ], next);
    }
  };

};



module.exports = function (app) {
  var ldap = libRequire('ldap-client')(app);
  var sessions = configurePassport(app, ldap.config);

  app.use(handleCsrfError);

  // TEMPORARY
  // var dbClient = libRequire('db-client');
  // var mockContributor = libRequire('mocks/joeSessionMock');

  return {
    // associateBestRole: function (roles, req, res, next) {
    //   var db = dbClient('samplestack-contributor', 'sc-pass');
    //   req.db = db;
    //   req.session = {
    //     contributor: mockContributor
    //   };
    //   next();
    // },

    createSession: sessions.createSession,


    tryReviveSession: function (req, res, next) {
      // is the request purporting to have a session?
      // if so, it should have a csrf ID, in which case we will try reviving
      // the user
      // otherwise, it's business as usual
      // we presently implemented, this will make a client receive an error
      // if they have a token mismatch or if their session is no longer
      // available. We could theoretically send a kill instruction here
      // and attempt to let the request go through anyway.
      if (req.cookies && req.cookies['connect.sid']) {
        async.waterfall([
          checkCsrfHeader.bind(app, req, res),
          sessions.createSession.bind(app, req, res),
          passport.initialize().bind(passport, req, res),
          passport.session().bind(passport, req, res),
        ], next);
      }
      else {
        // no sign of a session -- move on
        next();
      }
    },

    login: function (req, res, next) {
      async.waterfall([
        checkCsrfHeader.bind(app, req, res),
        sessions.loginSession.bind(app, req, res)
      ], next);
    },

    associateBestRole: pickRole,

    logout: function (req, res, next) {
      try {
        if (!req.session) {
          res.status(454).send({ message:'Session Not Found' });
        }
        if (req.user) {
          var uid = req.user.uid;
          // TODO this is the passport logout function -- does it clear the
          // session in the database?
          // what else does it do?
          req.logout();
          delete users[uid];
        }
        else {
          req.session.destroy();
        }
        res.status(205).send({ message:'Reset Content' });
      }
      catch (err) {
        next(err);
      }
    }
  };
};
