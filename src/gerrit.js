// Copyright 2019 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

(function(namespace) {

  if (namespace.gerrit)
    return;

  var gerrit = {};
  namespace.gerrit = gerrit;

  // Pattern used to check if a message is autogenerated.
  var AUTOGENERATED_REGEXP =
      new RegExp("^Patch Set [1-9][0-9]*: Commit-Queue\\+[12]$");

  // A single message in a CL.
  function Message(json) {
    this.json_ = json;
  }

  // Returns whether the message is autogenerated.
  Message.prototype.isAutogenerated = function() {
    if (this.json_.tag && this.json_.tag.startsWith("autogenerated:"))
      return true;

    if (AUTOGENERATED_REGEXP.exec(this.json_.message) !== null)
      return true;

    return false;
  };

  // Returns whether the user is the author of this message.
  Message.prototype.isAuthoredBy = function(user) {
    return !this.isAutogenerated() &&
            this.json_.real_author._account_id == user._account_id;
  };

  // Returns the time of the message.
  Message.prototype.getTime = function() {
    // Gerrit returns times in the format "YYYY-MM-DD HH:MM:SS.000000000", in
    // UTC.
    return new Date(this.json_.date + " UTC");
  };

  Message.wrap = function(json) {
    return new Message(json);
  };

  gerrit.Message = Message;

  // A single CL in a search result.
  function Changelist(host, json) {
    this.host_ = host;
    this.json_ = json;
    this.description_ = null;
    this.reviewers_ = null;
    this.messages_ = null;
  }

  // Returns the underlying json data.
  Changelist.prototype.toJSON = function() {
    return this.json_;
  };

  // Returns whether the user is the owner of this CL.
  Changelist.prototype.isOwner = function(user) {
    return this.json_.owner._account_id === user._account_id;
  };

  // Returns whether the CL is submittable.
  Changelist.prototype.isSubmittable = function() {
    return this.json_.submittable;
  };

  // Returns whether the CL has unresolved comments.
  Changelist.prototype.hasUnresolvedComments = function() {
    return this.json_.unresolved_comment_count !== 0;
  };

  // Returns the number of lines changed by this CL.
  Changelist.prototype.getDeltaSize = function() {
    return this.json_.insertions + this.json_.deletions;
  };

  // Retuns the size category for this CL.
  Changelist.prototype.getSizeCategory = function() {
    var deltaSize = this.getDeltaSize();
    if (deltaSize < 30) {
      return Changelist.SMALL;
    }
    if (deltaSize < 300) {
      return Changelist.MEDIUM;
    }
    return Changelist.LARGE;
  };

  // Returns all the reviewers, including owner for a CL that match a filter.
  Changelist.prototype.filterReviewers = function(filter) {
    var codeReviewLabel = this.json_.labels['Code-Review'];
    return ((codeReviewLabel && codeReviewLabel.all) || [])
        .filter(function(reviewer) {
            return !!reviewer._account_id && filter(reviewer);
        });
  }

  // Returns whether the user has reviewed this CL.
  Changelist.prototype.hasReviewed = function(user) {
    return this.filterReviewers(function(reviewer) {
      return reviewer.value > 0 && reviewer._account_id === user._account_id;
    }).length !== 0;
  };

  // Returns whether the message is stale (i.e. the last message on it
  // was posted more than 24h ago).
  Changelist.prototype.isStale = function() {
    var filteredMessages = this.getMessages().filter(function(message) {
      return !message.isAutogenerated();
    });

    var lastMessage = filteredMessages[filteredMessages.length - 1];
    if (!lastMessage)
      return true;

    var timeSinceLastMessageInMilliseconds =
        new Date().getTime() - lastMessage.getTime();
    return timeSinceLastMessageInMilliseconds > 1000 * 3600 * 24;
  };

  // Returns whether the author commented more recently than user.
  Changelist.prototype.authorCommentedAfterUser = function(user) {
    var owner = this.json_.owner;
    var filteredMessages = this.getMessages().filter(function(message) {
      return message.isAuthoredBy(user) || message.isAuthoredBy(owner);
    });

    var lastMessage = filteredMessages[filteredMessages.length - 1];
    return !lastMessage || lastMessage.isAuthoredBy(owner);
  };

  // Returns the type of attention this CL needs from the given user.
  Changelist.prototype.getCategory = function(user) {
    if (this.isOwner(user)) {
      if (this.isSubmittable() && !this.hasUnresolvedComments())
        return Changelist.READY_TO_SUBMIT;

      if (this.getReviewers().length == 0)
        return Changelist.NOT_MAILED;

      if (this.hasUnresolvedComments())
        return Changelist.OUTGOING_NEEDS_ATTENTION;

      if (this.isStale())
        return Changelist.STALE;

      return Changelist.NONE;
    }

    if (!this.hasReviewed(user)) {
      // The heuristic used to determine how to categorize the message is weak
      // because it is not possible to retrieve all the comments using the API
      // of Gerrit. So, ignore the has_unresolved_comments if the user left a
      // comment message more recently than the owner.
      if (this.authorCommentedAfterUser(user))
        return Changelist.INCOMING_NEEDS_ATTENTION;

      return Changelist.NONE;
    }

    return Changelist.NONE;
  };

  // Returns an Url to open Gerrit at this CL.
  Changelist.prototype.getGerritUrl = function() {
    return this.host_ + '/c/' + this.json_.project + '/+/' + this.json_._number;
  };

  // Returns the list of reviewers for this CL.
  Changelist.prototype.getReviewers = function() {
    if (this.reviewers_ === null) {
      var owner = this.json_.owner;
      this.reviewers_ = this.filterReviewers(function(reviewer) {
        return reviewer._account_id !== owner._account_id;
      });
    }
    return this.reviewers_;
  };

  // Returns the list of messages for this CL.
  Changelist.prototype.getMessages = function() {
    if (this.messages_ === null) {
      this.messages_ = this.json_.messages.map(Message.wrap);
    }
    return this.messages_;
  };

  // Returns the author of this CL.
  //
  // Requires detailed information (see gerrit.fetchReviews).
  Changelist.prototype.getAuthor = function() {
    return this.json_.owner.name;
  };

  // Returns the CL description.
  //
  // Requires detailed information (see gerrit.fetchReviews).
  Changelist.prototype.getDescription = function() {
    if (this.description_ === null) {
      this.description_ = new Description(
          this.json_.revisions[this.json_.current_revision].commit.message);
    }
    return this.description_;
  };

  Changelist.wrap = function(host, json) {
    return new Changelist(host, json);
  };

  // The CL size categories.
  Changelist.SMALL = 'small';
  Changelist.MEDIUM = 'medium';
  Changelist.LARGE = 'large';

  // The CL does not require any attention.
  Changelist.NONE = 'none';

  // The CL is stale (no recent activity).
  Changelist.STALE = 'stale';

  // The CL has not been sent for review yet.
  Changelist.NOT_MAILED = 'not_mailed';

  // Someone else is waiting for this user to review the CL.
  Changelist.INCOMING_NEEDS_ATTENTION = 'incoming_needs_attention';

  // The CL is authored by this user and requires this user's attention.
  Changelist.OUTGOING_NEEDS_ATTENTION = 'outgoign_needs_attention';

  // This CL is full approved, the author can submit.
  Changelist.READY_TO_SUBMIT = 'ready_to_submit';

  gerrit.Changelist = Changelist;

  // Wrapper around a changelist description.
  function Description(text) {
    this.text_ = text;
    this.message_ = null;
    this.attibutes_ = null;
  }

  // Returns the raw text of the description.
  Description.prototype.getText = function() {
    return this.text_;
  };

  // Returns just the message, not the attributes at the bottom.
  Description.prototype.getMessage = function() {
    this.ensureParsed();
    return this.message_;
  };

  // Returns the list of attributes.
  Description.prototype.getAttributeList = function() {
    this.ensureParsed();
    return this.attributes_;
  }

  // Ensure that the description is parsed.
  Description.prototype.ensureParsed = function() {
    if (this.message_ === null) {
      var parsed = Description.parse(this.text_);
      this.message_ = parsed[0];
      this.attributes_ = parsed[1];
    }
  };

  // Parse the CL description.
  Description.parse = function(text) {
    var ATTRIBUTE_RE = /^\s*([-A-Za-z]+)[=:](.*)$/;
    var lines = text.split('\n');
    var cutoff = lines.length - 1;
    // Peel off the trailing empty lines.
    while (cutoff >= 1 && lines[cutoff] === '')
      cutoff--;
    // Peel off the attributes.
    var attributes = [];
    while (cutoff >= 1) {
      if (lines[cutoff] !== '') {
        var match = ATTRIBUTE_RE.exec(lines[cutoff]);
        if (!match)
          break;

        attributes.push([match[1], match[2]]);
      }
      cutoff--;
    }
    // Peel off any empty line separating the attributes and the message.
    while (cutoff >= 1 && lines[cutoff] === '')
      cutoff--;
    // Set the description attributes.
    return [lines.splice(0, cutoff + 1).join('\n'), attributes.reverse()];
  };

  // The result of a search query.
  function SearchResult(host, user, data) {
    this.host_ = host;
    this.user_ = user;
    this.data_ = data;
  }

  // Returns data required to recreate the SearchResult.
  SearchResult.prototype.toJSON = function() {
    return {host: this.host_, user: this.user_, data: this.data_};
  };

  // Returns a map from a type of attention to the CLs that needs that
  // attention from the user.
  SearchResult.prototype.getCategoryMap = function() {
    var result = new utils.Map();
    var user = this.getAccount();
    this.data_.forEach(function(cl) {
      var attention = cl.getCategory(user);
      if (!result.has(attention)) {
        result.put(attention, []);
      }
      var cls = result.get(attention);
      if (!cls.includes(cl)) {
        cls.push(cl);
      }
    });
    return result;
  };

  // Returns the user account for this search result.
  SearchResult.prototype.getAccount = function() {
    return this.user_;
  };

  SearchResult.wrap = function(host, user, data) {
    return new SearchResult(
        host,
        user,
        data.map(function(json) { return Changelist.wrap(host, json); }));
  };

  gerrit.SearchResult = SearchResult;

  // The result of multiple search queries.
  function SearchResults(results) {
    this.results_ = results;
  }

  // Returns the data required to recreate the SearchResult.
  SearchResults.prototype.toJSON = function() {
    return this.results_;
  };

  // Returns a map from a type of attention to the CLs that need that
  // attention from the user.
  SearchResults.prototype.getCategoryMap = function() {
    var categories = new utils.Map();
    this.results_.forEach(function(result) {
      result.getCategoryMap().forEach(function(attention, cls) {
        if (!categories.has(attention)) {
          categories.put(attention, []);
        }
        categories.put(attention, categories.get(attention).concat(cls));
      });
    });
    return categories;
  };

  gerrit.SearchResults = SearchResults;

  // Parse a JSON reply from Gerrit and return a Promise.
  //
  // All Gerrit JSON replies start with )]}'\n. The function validates this
  // and return a rejected Promise if this is not the case.
  gerrit.parseJSON = function(reply) {
    var header = reply.substring(0, 5);
    if (header === ")]}'\n") {
      return Promise.resolve(JSON.parse(reply.substring(5)));
    }

    return Promise.reject(new Error(
        'Unexpected reply from Gerrit server: ' + header + '...'));
  };

  // Sends a request using the Gerrit JSON API.
  //
  // See https://gerrit-review.googlesource.com/Documentation/rest-api.html
  // for the documentation of the gerrit API.
  //
  // Returns a promise containing the JSON reply or an error.
  gerrit.sendRequest = function(host, path, params) {
    let tryFetch = function() {
      return browser.fetchUrl(host + path, params, {
        'pragma': 'no-cache',
        'cache-control': 'no-cache, must-revalidate',
      })
    };

    return tryFetch()
      .catch(function(error) {
        // Just pass through non-login errors.
        if (!(error instanceof browser.FetchError) || !error.is_login_error) {
          return Promise.resolve(error);
        }
        // Some Gerrit instances attempt to redirect the user via an
        // authentication server every few hours to refresh some cookies. Such
        // redirects will fail, due to Chrome's CORS restrictions.
        //
        // In these cases, we can attempt to send an opaque request (with "mode:
        // no-cors") that _will_ successfully redirect via the authentication
        // server and refresh any cookies, and then send the original request
        // again.
        //
        // This won't solve cases where a user needs to type in a password, but
        // will allow GerritMonitor to continue working if the problem is simply
        // an authentication cookie refresh was required.
        return fetch(host, {
            mode: 'no-cors',
            credentials: 'include',
          })
          .then(function(_) {
            // Try original request again.
            return tryFetch();
          })
          .catch(function(_) {
            // If we failed, return the original error we got.
            return Promise.resolve(error);
          });
      });
  };

  // Returns a promise with the information of the user account.
  gerrit.fetchAccount = function(host) {
    return gerrit.sendRequest(host, '/accounts/self')
      .then(function(response) {
        if (response.substring(0, 5) != ")]}'\n") {
          return Promise.reject(new Error(
              'Cannot fetch account.' +
              config.LOGIN_PROMPT));
        }
        return Promise.resolve(response);
      }).then(gerrit.parseJSON);
  };

  // Returns a promise with all reviews requiring attention.
  gerrit.fetchReviews = function(host, account, detailed) {
    var params = [];
    var userid = account._account_id;
    params.push(['q', 'status:open owner:' + userid]);
    params.push(['q', 'status:open -is:ignored reviewer:' + userid + ' -owner:' + userid]);
    params.push(['o', 'DETAILED_LABELS']);
    params.push(['o', 'REVIEWED']);
    params.push(['o', 'SUBMITTABLE']);
    params.push(['o', 'MESSAGES']);
    if (detailed) {
      params.push(['o', 'DETAILED_ACCOUNTS']);
      params.push(['o', 'CURRENT_REVISION']);
      params.push(['o', 'CURRENT_COMMIT']);
    }
    return gerrit.sendRequest(host, '/changes/', params)
      .then(gerrit.parseJSON)
      .then(function(results) {
      return Promise.resolve(SearchResult.wrap(
          host, account, [].concat.apply([], results)));
    });
  };

  // Returns a promise with a list of all host that are configured
  // including those that have no permissions granted.
  gerrit.fetchAllInstances = function() {
    return Promise.all([
        browser.loadOptions(),
        browser.getAllowedOrigins(),
      ]).then(function(values) {
        var instances = [];
        var origins = values[1];
        values[0].instances.forEach(function(instance) {
          // Version of the extension prior to 0.7.7 allowed instance.host
          // to contains a trailing '/' which caused issue as some gerrit
          // instances fails when there are '//' in the path. Fix the host
          // by dropping the trailing '/'.

          var match = config.ORIGIN_REGEXP.exec(instance.host);
          if (match !== null) {
            instances.push({
              host: match[0],
              name: instance.name,
              enabled: instance.enabled && origins.includes(match[1] + "/*"),
            });
          }
        });
        return Promise.resolve(instances);
      });
  };

  // Returns a promise with a list of all host that the extension has
  // been granted permissions to access.
  gerrit.fetchAllowedInstances = function() {
    return gerrit.fetchAllInstances().then(function(instances) {
      return Promise.resolve(instances.filter(function(instance) {
        return instance.enabled;
      }));
    });
  };

})(this);
